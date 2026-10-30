import fs from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildPgDatabaseWithMigrations } from '../src/utils/buildPgDatabaseWithMigrations.js'

const mocks = vi.hoisted(() => {
  const adminClient = {
    connect: vi.fn(),
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    end: vi.fn(),
  }
  const migrationClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  }
  const pool = {
    connect: vi.fn().mockResolvedValue(migrationClient),
    end: vi.fn(),
  }
  return {
    adminClient,
    migrationClient,
    pool,
    // biome-ignore lint/complexity/useArrowFunction: pg clients are instantiated with new.
    Client: vi.fn(function () {
      return adminClient
    }),
    // biome-ignore lint/complexity/useArrowFunction: pg pools are instantiated with new.
    Pool: vi.fn(function () {
      return pool
    }),
  }
})

vi.mock('pg', () => ({ Client: mocks.Client, Pool: mocks.Pool }))

const config = { user: 'mediator_user', password: 'test-password', host: 'localhost', port: 5432 }
const targetDatabase = 'messagepickuprepository'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.adminClient.connect.mockReset().mockResolvedValue(undefined)
  mocks.adminClient.end.mockReset().mockResolvedValue(undefined)
  mocks.adminClient.query.mockReset().mockResolvedValue({ rowCount: 1 })
  mocks.migrationClient.query.mockReset().mockResolvedValue({ rows: [] })
  mocks.migrationClient.release.mockReset()
  mocks.pool.connect.mockReset().mockResolvedValue(mocks.migrationClient)
  mocks.pool.end.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

test('uses postgres for maintenance and the configured target for migrations, not the username or PGDATABASE', async () => {
  vi.stubEnv('PGDATABASE', 'unexpected_database')
  await buildPgDatabaseWithMigrations(undefined, config, targetDatabase)

  expect(mocks.Client).toHaveBeenCalledExactlyOnceWith({ ...config, database: 'postgres' })
  expect(mocks.adminClient.query).toHaveBeenCalledWith('SELECT 1 FROM pg_database WHERE datname = $1', [targetDatabase])
  expect(mocks.Pool).toHaveBeenCalledExactlyOnceWith({ ...config, database: targetDatabase })
  expect(mocks.migrationClient.query).toHaveBeenCalledWith('BEGIN')
  expect(mocks.migrationClient.query).toHaveBeenCalledWith('COMMIT')
  expect(mocks.adminClient.end).toHaveBeenCalledOnce()
  expect(mocks.migrationClient.release).toHaveBeenCalledOnce()
  expect(mocks.pool.end).toHaveBeenCalledOnce()
})

test('locks before schema creation and version inspection', async () => {
  await buildPgDatabaseWithMigrations(undefined, config, targetDatabase)
  const statements = mocks.migrationClient.query.mock.calls.map(([sql]) => sql)
  expect(statements[0]).toBe('BEGIN')
  expect(statements[1]).toBe('SELECT pg_advisory_xact_lock($1)')
  expect(statements[2]).toContain('CREATE TABLE IF NOT EXISTS schema_version')
  expect(statements[3]).toContain('SELECT version')
})

test('permission failures roll back, release the connection, close the pool and reject', async () => {
  const error = new Error('permission denied for table schema_version')
  mocks.migrationClient.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockRejectedValueOnce(error)
  await expect(buildPgDatabaseWithMigrations(undefined, config, targetDatabase)).rejects.toBe(error)
  expect(mocks.migrationClient.query).toHaveBeenCalledWith('ROLLBACK')
  expect(mocks.migrationClient.query).not.toHaveBeenCalledWith('COMMIT')
  expect(mocks.migrationClient.release).toHaveBeenCalledWith(true)
  expect(mocks.pool.end).toHaveBeenCalledOnce()
})

test('preserves the migration error when rollback and pool cleanup also fail', async () => {
  const error = new Error('migration failed')
  const rollbackError = new Error('rollback failed')
  const cleanupError = new Error('pool cleanup failed')
  // Fail after BEGIN so rollback is attempted.
  mocks.migrationClient.query
    .mockReset()
    .mockResolvedValueOnce({ rows: [] })
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(rollbackError)
  mocks.pool.end.mockRejectedValueOnce(cleanupError)
  const result = buildPgDatabaseWithMigrations(undefined, config, targetDatabase)
  await expect(result).rejects.toBe(error)
  expect(mocks.migrationClient.release).toHaveBeenCalledWith(true)
})

test('closes the pool if acquiring a connection fails', async () => {
  const error = new Error('connection refused')
  mocks.pool.connect.mockRejectedValueOnce(error)
  await expect(buildPgDatabaseWithMigrations(undefined, config, targetDatabase)).rejects.toBe(error)
  expect(mocks.pool.end).toHaveBeenCalledOnce()
})

test('SQL migration failures reject with the filename and roll back', async () => {
  vi.spyOn(fs, 'readFileSync').mockReturnValue('INVALID SQL')
  mocks.migrationClient.query.mockImplementation(async (sql: string) => {
    if (sql === 'INVALID SQL') throw new Error('syntax error')
    return { rows: [] }
  })
  await expect(buildPgDatabaseWithMigrations(undefined, config, targetDatabase)).rejects.toThrow(
    'Failed to apply 001-initial-schema.sql: syntax error'
  )
  expect(mocks.migrationClient.query).toHaveBeenCalledWith('ROLLBACK')
  expect(mocks.migrationClient.query).not.toHaveBeenCalledWith('COMMIT')
  expect(mocks.pool.end).toHaveBeenCalledOnce()
})

test('missing migration directory rejects instead of silently skipping', async () => {
  vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
    throw new Error('directory missing')
  })
  await expect(buildPgDatabaseWithMigrations(undefined, config, targetDatabase)).rejects.toThrow('directory missing')
  expect(mocks.pool.connect).not.toHaveBeenCalled()
  expect(mocks.pool.end).toHaveBeenCalledOnce()
})

test('empty migration directory rejects instead of reporting success', async () => {
  vi.spyOn(fs, 'readdirSync').mockReturnValueOnce([])
  await expect(buildPgDatabaseWithMigrations(undefined, config, targetDatabase)).rejects.toThrow('No SQL migrations')
  expect(mocks.pool.end).toHaveBeenCalledOnce()
})

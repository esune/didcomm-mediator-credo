import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Pool, escapeIdentifier } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPgDatabaseWithMigrations } from '../src/utils/buildPgDatabaseWithMigrations'

const connectionString = process.env.PICKUP_TEST_DATABASE_URL

describe.skipIf(!connectionString)('PostgreSQL migrations', () => {
  const url = new URL(connectionString ?? 'postgres://postgres:password@localhost:5432/postgres')
  const config = {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: Number(url.port || 5432),
  }
  let directory: string
  let database: string

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'credo-migrations-'))
    database = `pickup-${randomUUID()}`
  })

  afterEach(async () => {
    const admin = new Pool({ ...config, database: 'postgres' })
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(database)}`)
    } finally {
      await admin.end()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes concurrent database creation and migration runners', async () => {
    await writeFile(path.join(directory, '001-initial.sql'), 'CREATE TABLE migrated (id INTEGER);')

    await Promise.all(
      Array.from({ length: 3 }, () => buildPgDatabaseWithMigrations(undefined, config, database, directory))
    )

    const pool = new Pool({ ...config, database })
    try {
      expect((await pool.query('SELECT version FROM schema_version')).rows).toEqual([{ version: 1 }])
      expect((await pool.query('SELECT * FROM migrated')).rows).toEqual([])
    } finally {
      await pool.end()
    }
  })

  it('throws and rolls back when a migration fails', async () => {
    await writeFile(path.join(directory, '001-initial.sql'), 'CREATE TABLE migrated (id INTEGER);')
    await writeFile(path.join(directory, '002-invalid.sql'), 'NOT VALID SQL;')

    await expect(buildPgDatabaseWithMigrations(undefined, config, database, directory)).rejects.toThrow(
      'Failed to apply 002-invalid.sql'
    )

    const pool = new Pool({ ...config, database })
    try {
      expect((await pool.query("SELECT to_regclass('migrated') AS table_name")).rows[0].table_name).toBeNull()
    } finally {
      await pool.end()
    }
  })

  it('applies a missing lower-numbered migration instead of skipping it', async () => {
    await writeFile(path.join(directory, '002-later.sql'), 'CREATE TABLE later (id INTEGER);')
    await buildPgDatabaseWithMigrations(undefined, config, database, directory)
    await writeFile(path.join(directory, '001-earlier.sql'), 'CREATE TABLE earlier (id INTEGER);')

    await buildPgDatabaseWithMigrations(undefined, config, database, directory)

    const pool = new Pool({ ...config, database })
    try {
      expect((await pool.query('SELECT version FROM schema_version ORDER BY version')).rows).toEqual([
        { version: 1 },
        { version: 2 },
      ])
    } finally {
      await pool.end()
    }
  })

  it('fails before connecting if migration assets are missing', async () => {
    await expect(
      buildPgDatabaseWithMigrations(undefined, config, database, path.join(directory, 'missing'))
    ).rejects.toThrow('Migrations directory not found')
  })

  it('does not mistake an enum in another schema for its own type', async () => {
    const initial = await readFile(path.join(__dirname, '../src/migrations/001-initial-schema.sql'), 'utf8')
    await writeFile(
      path.join(directory, '001-initial.sql'),
      `CREATE SCHEMA other; CREATE TYPE other.message_state AS ENUM ('pending', 'sending');\n${initial}`
    )

    await buildPgDatabaseWithMigrations(undefined, config, database, directory)

    const pool = new Pool({ ...config, database })
    try {
      expect((await pool.query("SELECT to_regtype('public.message_state') AS type_name")).rows[0].type_name).toBe(
        'message_state'
      )
    } finally {
      await pool.end()
    }
  })
})

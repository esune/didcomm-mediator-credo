import { describe, expect, it, vi } from 'vitest'
import { PostgresMessagePickupRepository } from '../src/PostgresMessagePickupRepository'
import { postgresConnectionConfig } from '../src/utils/postgresConnectionConfig'

describe('PostgreSQL connection controls', () => {
  const options = { postgresHost: 'database', postgresUser: 'user@tenant', postgresPassword: 'password:/?#@%' }

  it('defaults to bounded pool and statement timeouts with a consistent database', () => {
    expect(postgresConnectionConfig(options)).toMatchObject({
      database: 'messagepickuprepository',
      port: 5432,
      max: 10,
      connectionTimeoutMillis: 10000,
      statement_timeout: 30000,
      user: options.postgresUser,
      password: options.postgresPassword,
    })
  })

  it('supports a custom port and disabled timeouts', () => {
    expect(
      postgresConnectionConfig({
        ...options,
        postgresPort: 5433,
        postgresMaxConnections: 5,
        postgresConnectionTimeoutMillis: 0,
        postgresStatementTimeoutMillis: 0,
      })
    ).toMatchObject({
      port: 5433,
      max: 5,
      connectionTimeoutMillis: 0,
      statement_timeout: 0,
    })
  })

  it.each([{ postgresPort: 0 }, { postgresMaxConnections: 0 }, { postgresStatementTimeoutMillis: -1 }])(
    'rejects invalid settings %j',
    (settings) => {
      expect(() => postgresConnectionConfig({ ...options, ...settings })).toThrow()
    }
  )

  it.each([undefined, 1000, 5, 0])('bounds pickup with limit %s', async (limit) => {
    const repository = new PostgresMessagePickupRepository({ ...options, maxPickupBatchSize: 10 })
    const query = vi.fn().mockResolvedValue({ rows: [] })
    Object.assign(repository, { messagesCollection: { query } })

    await repository.takeFromQueue({ connectionId: 'connection', limit })

    expect(query.mock.calls[0][1][2]).toBe(Math.min(limit ?? 10, 10))
  })

  it('rejects invalid pickup limits before querying storage', async () => {
    const repository = new PostgresMessagePickupRepository(options)

    await expect(repository.takeFromQueue({ connectionId: 'connection', limit: -1 })).rejects.toThrow()
    await expect(repository.takeFromQueue({ connectionId: 'connection', limit: 0.5 })).rejects.toThrow()
  })
})

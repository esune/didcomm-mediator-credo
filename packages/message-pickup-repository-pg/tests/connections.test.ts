import { MessageForwardingStrategy } from '@credo-ts/core/build/modules/routing/MessageForwardingStrategy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresMessagePickupRepository } from '../src/PostgresMessagePickupRepository'

const state = vi.hoisted(() => ({ pools: [] as any[], listeners: [] as any[] }))

vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Pool: class extends EventEmitter {
      query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
      end = vi.fn()
      connect = vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [{ acquired: false }] }),
        release: vi.fn(),
      })
      constructor(public options: unknown) {
        super()
        state.pools.push(this)
      }
    },
  }
})

vi.mock('pg-pubsub', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    default: class extends EventEmitter {
      addChannel = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)

      constructor(public options: unknown) {
        super()
        state.listeners.push(this)
      }
    },
  }
})

vi.mock('../src/utils/buildPgDatabaseWithMigrations', () => ({
  buildPgDatabaseWithMigrations: vi.fn().mockResolvedValue(undefined),
}))

describe('PostgreSQL pickup connections', () => {
  const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn() }
  const options = {
    postgresUser: 'user@tenant',
    postgresPassword: 'password:/?#@%',
    postgresHost: 'database.internal',
    logger: logger as any,
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    state.pools.length = 0
    state.listeners.length = 0
  })
  afterEach(() => vi.useRealTimers())

  it.each([
    [undefined, 'messagepickuprepository'],
    ['', 'messagepickuprepository'],
    ['custom-database', 'custom-database'],
  ])('shares database configuration when the name is %s', async (postgresDatabaseName, expectedDatabase) => {
    const repository = new PostgresMessagePickupRepository({ ...options, postgresDatabaseName })
    const agent = {
      events: { on: vi.fn() },
      mediator: { config: { messageForwardingStrategy: MessageForwardingStrategy.QueueOnly } },
      dependencyManager: { resolve: vi.fn() },
    }

    await repository.initialize({ agent: agent as any })

    expect(state.listeners[0].options).toMatchObject({
      user: options.postgresUser,
      password: options.postgresPassword,
      host: options.postgresHost,
      database: expectedDatabase,
      port: 5432,
    })
    expect(state.pools[0].options).toEqual(state.listeners[0].options)
  })

  it('handles background Pub/Sub errors', () => {
    new PostgresMessagePickupRepository(options)
    const error = new Error('listener connection dropped')

    expect(() => state.listeners[0].emit('error', error)).not.toThrow()
    expect(logger.error).toHaveBeenCalledWith('[pubsub] Background PostgreSQL listener error', { cause: error })
  })

  it.each([MessageForwardingStrategy.QueueOnly, MessageForwardingStrategy.DirectDelivery])(
    'handles idle pool errors for strategy %s',
    async (strategy) => {
      const repository = new PostgresMessagePickupRepository(options)
      const agent = {
        events: { on: vi.fn() },
        mediator: { config: { messageForwardingStrategy: strategy } },
        dependencyManager: { resolve: vi.fn() },
      }
      await repository.initialize({ agent: agent as any })
      const error = new Error('idle connection dropped')

      expect(() => state.pools[0].emit('error', error)).not.toThrow()
      expect(logger.error).toHaveBeenCalledWith('[pool] Background PostgreSQL connection error', { cause: error })
    }
  )
})

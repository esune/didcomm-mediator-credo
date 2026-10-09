import { DidExchangeState, DidKey, Key, KeyType } from '@credo-ts/core'
import { MessageForwardingStrategy } from '@credo-ts/core/build/modules/routing/MessageForwardingStrategy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresMessagePickupRepository } from '../src/PostgresMessagePickupRepository'

const query = vi.hoisted(() => vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }))
vi.mock('pg', () => ({
  Pool: class {
    query = query
    end = vi.fn()
      on = vi.fn()
      connect = vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [{ acquired: false }] }),
        release: vi.fn(),
      })
  },
}))
vi.mock('pg-pubsub', () => ({
  default: class {
    addChannel = vi.fn()
      on = vi.fn()
      close = vi.fn()
  },
}))
vi.mock('../src/utils/buildPgDatabaseWithMigrations', () => ({ buildPgDatabaseWithMigrations: vi.fn() }))

describe('keylist reassignment', () => {
  const first = new DidKey(Key.fromPublicKey(new Uint8Array(32).fill(1), KeyType.Ed25519))
  const second = new DidKey(Key.fromPublicKey(new Uint8Array(32).fill(2), KeyType.Ed25519))
  let record: any
  let repository: PostgresMessagePickupRepository
  const update = vi.fn()
  const register = vi.fn()
  const agent = {
    context: {},
    events: { on: vi.fn() },
    mediator: { config: { messageForwardingStrategy: MessageForwardingStrategy.QueueAndLiveModeDelivery } },
    dependencyManager: {
      registerMessageHandlerMiddleware: register,
      resolve: (token: { name: string }) =>
        token.name === 'MediationRepository'
          ? { findSingleByQuery: async () => record, getById: async () => record, update }
          : { saveLiveSession: vi.fn() },
    },
  }
  const context = () => ({
    agentContext: {},
    encryptedMessage: {},
    connection: {
      id: 'new-connection',
      theirDid: 'did:peer:recipient',
      state: DidExchangeState.Completed,
      isReady: true,
    },
    message: {
      type: 'https://didcomm.org/coordinate-mediation/1.0/keylist-update',
      updates: [
        { action: 'add', recipientKey: first.did },
        { action: 'add', recipientKey: second.key.publicKeyBase58 },
      ],
    },
  })
  beforeEach(async () => {
    vi.clearAllMocks()
    record = {
      id: 'old-record',
      connectionId: 'old-connection',
      recipientKeys: [first.key.publicKeyBase58, second.key.publicKeyBase58, 'unrelated'],
    }
    repository = new PostgresMessagePickupRepository({
      postgresHost: 'host',
      postgresUser: 'user',
      postgresPassword: 'password',
    })
    await repository.initialize({ agent: agent as any })
  })
  afterEach(async () => {
    await repository.shutdown()
  })

  it('processes every addition, preserves unrelated keys, and rebinds queued messages', async () => {
    await register.mock.calls[0][0](context(), vi.fn())

    expect(record.recipientKeys).toEqual(['unrelated'])
    expect(update).toHaveBeenCalledTimes(2)
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET connection_id = $1, state = 'pending'"), [
      'new-connection',
      first.did,
    ])
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET connection_id = $1, state = 'pending'"), [
      'new-connection',
      second.did,
    ])
  })

  it('does not modify old routes if the protocol handler rejects the update', async () => {
    await expect(
      register.mock.calls[0][0](context(), vi.fn().mockRejectedValue(new Error('not granted')))
    ).rejects.toThrow('not granted')

    expect(record.recipientKeys).toHaveLength(3)
    expect(update).not.toHaveBeenCalled()
  })
})

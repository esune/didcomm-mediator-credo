import { DidExchangeState } from '@credo-ts/core'
import { MessageForwardingStrategy } from '@credo-ts/core/build/modules/routing/MessageForwardingStrategy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresMessagePickupRepository } from '../src/PostgresMessagePickupRepository'

const query = vi.hoisted(() => vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }))
vi.mock('pg', () => ({
  Pool: class {
    query = query
    end = vi.fn()
    on = vi.fn()
  },
}))
vi.mock('pg-pubsub', () => ({
  default: class {
    addChannel = vi.fn()
    on = vi.fn()
  },
}))
vi.mock('../src/utils/buildPgDatabaseWithMigrations', () => ({ buildPgDatabaseWithMigrations: vi.fn() }))

describe('pickup middleware', () => {
  let repository: PostgresMessagePickupRepository
  const socket = { type: 'WebSocket', send: vi.fn() }
  const saveLiveSession = vi.fn()
  const update = vi.fn()
  const agent = {
    context: {},
    events: { on: vi.fn() },
    mediator: { config: { messageForwardingStrategy: MessageForwardingStrategy.QueueAndLiveModeDelivery } },
    messagePickup: { getLiveModeSession: vi.fn() },
    dependencyManager: {
      registerMessageHandlerMiddleware: vi.fn(),
      resolve: (token: { name: string }) => {
        if (token.name === 'TransportService') return { findSessionByConnectionId: () => socket }
        if (token.name === 'MessagePickupSessionService') return { saveLiveSession }
        return { update }
      },
    },
  }
  const context = (type: string) => ({
    agentContext: {},
    encryptedMessage: {},
    message: { type },
    connection: {
      id: 'connection',
      theirDid: 'did:peer:recipient',
      state: DidExchangeState.Completed,
      isReady: true,
      getTag: vi.fn(),
      setTag: vi.fn(),
    },
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    socket.send.mockReset()
    agent.messagePickup.getLiveModeSession.mockReset()
    query.mockResolvedValue({ rows: [], rowCount: 0 })
    repository = new PostgresMessagePickupRepository({
      postgresHost: 'host',
      postgresUser: 'user',
      postgresPassword: 'password',
    })
    await repository.initialize({ agent: agent as any })
    vi.spyOn(repository, 'takeFromQueue').mockResolvedValue([])
  })
  afterEach(async () => {
    await repository.shutdown()
    vi.restoreAllMocks()
  })
  const middleware = () => agent.dependencyManager.registerMessageHandlerMiddleware.mock.calls[0][0]

  it('passes explicit live-delivery control to the protocol handler', async () => {
    const next = vi.fn()

    await middleware()(context('https://didcomm.org/messagepickup/2.0/live-delivery-change'), next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(saveLiveSession).not.toHaveBeenCalled()
    expect(repository.takeFromQueue).not.toHaveBeenCalled()
  })

  it('responds to rapid trust pings while throttling only implicit pickup', async () => {
    const next = vi.fn()
    const ping = context('https://didcomm.org/trust_ping/1.0/ping')

    await middleware()(ping, next)
    await middleware()(ping, next)

    expect(next).toHaveBeenCalledTimes(2)
    expect(saveLiveSession).toHaveBeenCalledTimes(1)
  })

  it('lets the protocol complete an initially unready connection', async () => {
    const next = vi.fn()
    const ping = context('https://didcomm.org/trust_ping/1.0/ping')
    ping.connection.isReady = false

    await middleware()(ping, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(saveLiveSession).not.toHaveBeenCalled()
  })

  it('deletes only successfully written messages and releases the failed remainder', async () => {
    const messages = [
      { id: 'first', encryptedMessage: {} as any, receivedAt: new Date() },
      { id: 'second', encryptedMessage: {} as any, receivedAt: new Date() },
    ]
    vi.mocked(repository.takeFromQueue).mockResolvedValue(messages)
    const remove = vi.spyOn(repository, 'removeMessages').mockResolvedValue(undefined)
    socket.send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('write failed'))

    await middleware()(context('https://didcomm.org/trust_ping/1.0/ping'), vi.fn())

    expect(repository.takeFromQueue).toHaveBeenCalledWith({
      connectionId: 'connection',
      limit: 10,
      deleteMessages: false,
    })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith({ connectionId: 'connection', messageIds: ['first'] })
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET state = 'pending'"), [
      'connection',
      ['first', 'second'],
    ])
  })
})

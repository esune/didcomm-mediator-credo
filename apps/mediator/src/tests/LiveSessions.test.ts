import { EventEmitter as NodeEventEmitter } from 'node:events'
import { EventEmitter, MessagePickupSessionService, TransportService } from '@credo-ts/core'
import { MessagePickupSessionRole } from '@credo-ts/core/build/modules/message-pickup/MessagePickupSession'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('patched live sessions', () => {
  const context = { dependencyManager: { resolve: vi.fn() } }
  const { Subject } = require(require.resolve('rxjs', { paths: [require.resolve('@credo-ts/core')] }))
  const stop = new Subject()
  const emitter = new EventEmitter({ EventEmitterClass: NodeEventEmitter } as any, stop)
  let transport: TransportService
  let pickup: MessagePickupSessionService
  const options = {
    connectionId: 'connection',
    protocolVersion: 'v2' as const,
    role: MessagePickupSessionRole.MessageHolder,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    transport = new TransportService(context as any, emitter)
    pickup = new MessagePickupSessionService()
    context.dependencyManager.resolve.mockImplementation((token) => {
      if (typeof token !== 'function') return stop
      if (token.name === 'TransportService') return transport
      return emitter
    })
    transport.saveSession({
      id: 'holder-socket',
      connectionId: 'connection',
      type: 'WebSocket',
      socket: { readyState: 1 },
    } as any)
  })

  it('keeps repeated enables idempotent', () => {
    for (let index = 0; index < 100; index++) pickup.saveLiveSession(context as any, options)

    expect((pickup as any).sessions).toHaveLength(1)
  })

  it('removes all stale duplicate sessions on explicit disable', () => {
    pickup.saveLiveSession(context as any, options)
    ;(pickup as any).sessions.push({ ...(pickup as any).sessions[0], id: 'duplicate' })

    pickup.removeLiveSession(context as any, { connectionId: options.connectionId })

    expect((pickup as any).sessions).toHaveLength(0)
  })

  it('keeps live mode until the last open WebSocket is removed', () => {
    transport.removeSession({ id: 'holder-socket' } as any)
    pickup.start(context as any)
    const first = { id: 'first', connectionId: 'connection', type: 'WebSocket', socket: { readyState: 1 } }
    const second = { ...first, id: 'second' }
    transport.saveSession(first as any)
    transport.saveSession(second as any)
    pickup.saveLiveSession(context as any, options)

    transport.removeSession(first as any)
    expect(pickup.getLiveSessionByConnectionId(context as any, options)).toBeDefined()
    transport.removeSession(second as any)
    expect(pickup.getLiveSessionByConnectionId(context as any, options)).toBeUndefined()
  })

  it('selects the newest usable return-routing session without excluding HTTP', () => {
    const session = {
      id: 'older',
      connectionId: 'connection',
      type: 'WebSocket',
      socket: { readyState: 1 },
      inboundMessage: { hasReturnRouting: () => true },
    }
    transport.saveSession(session as any)
    transport.saveSession({ ...session, id: 'closed', socket: { readyState: 3 } } as any)
    expect(transport.findSessionByConnectionId('connection')?.id).toBe('older')
    transport.saveSession({ ...session, id: 'http', type: 'Http', socket: undefined } as any)
    expect(transport.findSessionByConnectionId('connection')?.id).toBe('http')
    transport.saveSession({
      ...session,
      id: 'no-return-route',
      inboundMessage: { hasReturnRouting: () => false },
    } as any)
    expect(transport.findSessionByConnectionId('connection')?.id).toBe('http')
  })

  it('does not create holder presence without a WebSocket but preserves recipient sessions', () => {
    transport.removeSession({ id: 'holder-socket' } as any)

    pickup.saveLiveSession(context as any, options)
    expect((pickup as any).sessions).toHaveLength(0)
    pickup.saveLiveSession(context as any, { ...options, role: MessagePickupSessionRole.Recipient })
    expect((pickup as any).sessions).toHaveLength(1)
  })
})

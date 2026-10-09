import { EventEmitter } from 'node:events'
import { MessageSender } from '@credo-ts/core'
import { WebSocketTransportSession, WsInboundTransport } from '@credo-ts/node/build/transport/WsInboundTransport'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

describe('patched WebSocket transport', () => {
  const logger = { debug: vi.fn(), error: vi.fn() }
  const payload = { ciphertext: 'message' } as any
  const context = {} as any

  beforeEach(() => vi.clearAllMocks())

  it('releases closed sockets across repeated reconnects', async () => {
    const server = new EventEmitter()
    const removeSession = vi.fn()
    const agent = {
      config: { logger, endpoints: ['ws://localhost'] },
      dependencyManager: { resolve: () => ({ removeSession }) },
    }
    const transport = new WsInboundTransport({ server: server as any })
    await transport.start(agent as any)

    for (let index = 0; index < 1000; index++) {
      const socket = Object.assign(new EventEmitter(), { addEventListener: vi.fn() })
      server.emit('connection', socket)
      expect(Object.keys((transport as any).socketIds)).toHaveLength(1)
      socket.emit('close')
    }

    expect(Object.keys((transport as any).socketIds)).toHaveLength(0)
    expect(removeSession).toHaveBeenCalledTimes(1000)
  })

  it('waits for the socket write callback before resolving', async () => {
    let complete: ((error?: Error) => void) | undefined
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn((_payload: string, callback: (error?: Error) => void) => {
        complete = callback
      }),
    }
    const session = new WebSocketTransportSession('session', socket as any, logger as any)
    let settled = false
    const result = session.send(context, payload).then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify(payload), expect.any(Function))
    complete?.()
    await result
    expect(settled).toBe(true)
  })

  it('contains protocol errors and terminates only the affected socket', async () => {
    const server = new EventEmitter()
    const socket = Object.assign(new EventEmitter(), { addEventListener: vi.fn(), terminate: vi.fn() })
    const transport = new WsInboundTransport({ server: server as any })
    await transport.start({
      config: { logger, endpoints: ['ws://localhost'] },
      dependencyManager: { resolve: () => ({ removeSession: vi.fn() }) },
    } as any)
    server.emit('connection', socket)

    expect(() => socket.emit('error', new Error('invalid frame'))).not.toThrow()
    expect(socket.terminate).toHaveBeenCalledTimes(1)
  })

  it('rejects callback errors without throwing outside the sender promise', async () => {
    const error = new Error('write failed')
    let complete: ((error?: Error) => void) | undefined
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn((_payload: string, callback: (error?: Error) => void) => {
        complete = callback
      }),
    }
    const session = new WebSocketTransportSession('session', socket as any, logger as any)
    const result = session.send(context, payload)

    expect(() => complete?.(error)).not.toThrow()
    await expect(result).rejects.toMatchObject({ message: 'WebSocket send message failed.', cause: error })
  })

  it('preserves rejection when the socket is already closed', async () => {
    const socket = { readyState: WebSocket.CLOSED, send: vi.fn() }
    const session = new WebSocketTransportSession('session', socket as any, logger as any)

    await expect(session.send(context, payload)).rejects.toThrow('WebSocket transport session has been closed.')
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('rejects synchronous write errors', async () => {
    const error = new Error('synchronous write failure')
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn(() => {
        throw error
      }),
    }
    const session = new WebSocketTransportSession('session', socket as any, logger as any)

    await expect(session.send(context, payload)).rejects.toBe(error)
  })

  it.each(['http', 'queue'])('allows Credo to fall back to %s after a failed WebSocket write', async (fallback) => {
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn((_payload: string, callback: (error?: Error) => void) => callback(new Error('write failed'))),
    }
    const session = new WebSocketTransportSession('session', socket as any, logger as any)
    Object.assign(session, { inboundMessage: { hasReturnRouting: () => true } })
    const repository = { addMessage: vi.fn().mockResolvedValue('message-id') }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const sender = new MessageSender(
      {} as any,
      { findSessionByConnectionId: () => session } as any,
      repository as any,
      logger as any,
      {} as any,
      {} as any,
      {} as any
    )
    sender.registerOutboundTransport({ supportedSchemes: ['http'], sendMessage } as any)
    vi.spyOn(sender as any, 'retrieveServicesByConnection').mockResolvedValue({
      services: fallback === 'http' ? [{ id: 'service', serviceEndpoint: 'http://receiver' }] : [],
      queueService: fallback === 'queue' ? {} : undefined,
    })

    await sender.sendPackage(context, {
      connection: { id: 'connection' } as any,
      recipientKey: 'did:key:recipient',
      encryptedMessage: payload,
    })

    expect(socket.send).toHaveBeenCalledTimes(1)
    if (fallback === 'http') {
      expect(sendMessage).toHaveBeenCalledWith({
        payload,
        endpoint: 'http://receiver',
        connectionId: 'connection',
      })
      expect(repository.addMessage).not.toHaveBeenCalled()
    } else {
      expect(repository.addMessage).toHaveBeenCalledWith({
        connectionId: 'connection',
        recipientDids: ['did:key:recipient'],
        payload,
      })
      expect(sendMessage).not.toHaveBeenCalled()
    }
  })
})

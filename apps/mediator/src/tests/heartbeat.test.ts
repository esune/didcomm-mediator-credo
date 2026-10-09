import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebSocketHeartbeat } from '../ManagedWsInboundTransport'

describe('WebSocket heartbeat', () => {
  afterEach(() => vi.useRealTimers())
  const setup = (seconds = 30) => {
    const clients = new Set<any>()
    const server = Object.assign(new EventEmitter(), { clients })
    const stop = createWebSocketHeartbeat(server as any, seconds)
    const socket = Object.assign(new EventEmitter(), { ping: vi.fn(), terminate: vi.fn() })
    clients.add(socket)
    server.emit('connection', socket)
    return { server, socket, stop }
  }

  it('terminates a half-open socket after a missed pong', () => {
    vi.useFakeTimers()
    const { socket, stop } = setup()

    vi.advanceTimersByTime(30000)
    expect(socket.ping).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30000)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    stop()
  })

  it('preserves healthy sockets and stops its timer when the server closes', () => {
    vi.useFakeTimers()
    const { server, socket } = setup()

    vi.advanceTimersByTime(30000)
    socket.emit('pong')
    vi.advanceTimersByTime(30000)
    expect(socket.terminate).not.toHaveBeenCalled()
    server.emit('close')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('supports disabling heartbeat', () => {
    vi.useFakeTimers()
    const { socket, stop } = setup(0)

    vi.advanceTimersByTime(120000)

    expect(socket.ping).not.toHaveBeenCalled()
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })
})

import { WsInboundTransport } from '@credo-ts/node'
import type { Server, WebSocket } from 'ws'

export function createWebSocketHeartbeat(server: Server, intervalSeconds: number): () => void {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 0 || intervalSeconds > 2147483) {
    throw new Error('WS_HEARTBEAT_SECONDS must be an integer between 0 and 2147483')
  }
  if (intervalSeconds === 0) return () => undefined
  const alive = new WeakSet<WebSocket>()
  const connected = (socket: WebSocket) => {
    alive.add(socket)
    socket.on('pong', () => alive.add(socket))
  }
  server.on('connection', connected)
  const timer = setInterval(() => {
    for (const socket of server.clients) {
      if (!alive.has(socket)) {
        socket.terminate()
        continue
      }
      alive.delete(socket)
      socket.ping((error?: Error) => {
        if (error) socket.terminate()
      })
    }
  }, intervalSeconds * 1000)
  timer.unref()
  const stop = () => {
    clearInterval(timer)
    server.off('connection', connected)
    server.off('close', stop)
  }
  server.on('close', stop)
  return stop
}

export class ManagedWsInboundTransport extends WsInboundTransport {
  private readonly stopHeartbeat: () => void

  public constructor(
    private readonly server: Server,
    intervalSeconds: number
  ) {
    super({ server })
    this.stopHeartbeat = createWebSocketHeartbeat(server, intervalSeconds)
  }

  public async stop(): Promise<void> {
    this.stopHeartbeat()
    for (const socket of this.server.clients) socket.terminate()
    await super.stop()
  }
}

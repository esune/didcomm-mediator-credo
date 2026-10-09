import { MessageSender } from '@credo-ts/core'
import { describe, expect, it, vi } from 'vitest'

describe('packed-message endpoint fallback', () => {
  const setup = (services: unknown[], queued = false) => {
    const addMessage = vi.fn().mockResolvedValue('message')
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const sender = new MessageSender(
      {} as any,
      { findSessionByConnectionId: () => undefined } as any,
      { addMessage } as any,
      { debug: vi.fn(), error: vi.fn() } as any,
      {} as any,
      {} as any,
      {} as any
    )
    sender.registerOutboundTransport({ supportedSchemes: ['http'], sendMessage } as any)
    vi.spyOn(sender as any, 'retrieveServicesByConnection').mockResolvedValue({
      services,
      queueService: queued ? {} : undefined,
    })
    const send = () =>
      sender.sendPackage({} as any, {
        connection: { id: 'connection' } as any,
        recipientKey: 'did:key:recipient',
        encryptedMessage: {} as any,
      })
    return { send, addMessage, sendMessage }
  }

  it('skips an unsupported scheme and tries the next usable endpoint', async () => {
    const { send, sendMessage, addMessage } = setup([
      { id: 'unsupported', serviceEndpoint: 'ftp://unsupported' },
      { id: 'http', serviceEndpoint: 'http://receiver' },
    ])

    await send()

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'http://receiver' }))
    expect(addMessage).not.toHaveBeenCalled()
  })

  it('uses a queue endpoint when no direct endpoint is supported', async () => {
    const { send, sendMessage, addMessage } = setup([{ id: 'unsupported', serviceEndpoint: 'ftp://unsupported' }], true)

    await send()

    expect(sendMessage).not.toHaveBeenCalled()
    expect(addMessage).toHaveBeenCalledTimes(1)
  })

  it('reports undeliverable instead of falsely reporting success', async () => {
    const { send, sendMessage } = setup([{ id: 'unsupported', serviceEndpoint: 'ftp://unsupported' }])

    await expect(send()).rejects.toThrow('Message is undeliverable')
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

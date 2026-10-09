import '@credo-ts/core'
import { MessageForwardingStrategy } from '@credo-ts/core/build/modules/routing/MessageForwardingStrategy'
import { MediatorService } from '@credo-ts/core/build/modules/routing/services/MediatorService'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('queued forward delivery failures', () => {
  const pickup = { queueMessage: vi.fn(), getLiveModeSession: vi.fn(), deliverMessagesFromQueue: vi.fn() }
  const sender = { sendPackage: vi.fn() }
  const logger = { warn: vi.fn() }
  const mediation = { connectionId: 'connection', assertReady: vi.fn(), assertRole: vi.fn() }
  const connection = { id: 'connection', assertReady: vi.fn() }
  const service = new MediatorService(
    { getSingleByRecipientKey: async () => mediation } as any,
    {} as any,
    pickup as any,
    {} as any,
    logger as any,
    { getById: async () => connection } as any
  )
  const context = (strategy: MessageForwardingStrategy) => ({
    message: { to: 'did:key:recipient', message: { ciphertext: 'message' } },
    agentContext: {
      dependencyManager: {
        resolve: (token: { name: string }) =>
          token.name === 'MediatorModuleConfig' ? { messageForwardingStrategy: strategy } : sender,
      },
    },
  })

  beforeEach(() => vi.resetAllMocks())

  it('accepts a persisted forward when live delivery fails', async () => {
    const error = new Error('socket closed')
    pickup.getLiveModeSession.mockResolvedValue({ id: 'session' })
    pickup.deliverMessagesFromQueue.mockRejectedValue(error)

    await expect(
      service.processForwardMessage(context(MessageForwardingStrategy.QueueAndLiveModeDelivery) as any)
    ).resolves.toBeUndefined()

    expect(pickup.queueMessage).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('Queued message live delivery failed', { cause: error })
  })

  it('does not hide queue insertion errors', async () => {
    pickup.queueMessage.mockRejectedValue(new Error('insert failed'))

    await expect(
      service.processForwardMessage(context(MessageForwardingStrategy.QueueAndLiveModeDelivery) as any)
    ).rejects.toThrow('insert failed')
    expect(pickup.deliverMessagesFromQueue).not.toHaveBeenCalled()
  })

  it('preserves queue-only delivery', async () => {
    await service.processForwardMessage(context(MessageForwardingStrategy.QueueOnly) as any)

    expect(pickup.queueMessage).toHaveBeenCalledTimes(1)
    expect(pickup.getLiveModeSession).not.toHaveBeenCalled()
  })

  it('preserves direct delivery errors', async () => {
    sender.sendPackage.mockRejectedValue(new Error('direct send failed'))

    await expect(
      service.processForwardMessage(context(MessageForwardingStrategy.DirectDelivery) as any)
    ).rejects.toThrow('direct send failed')
    expect(pickup.queueMessage).not.toHaveBeenCalled()
  })
})

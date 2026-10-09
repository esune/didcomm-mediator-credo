import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import config from '../../../../config'
import { firebaseApps } from '../../firebase'
import { PushNotificationsFcmService } from '../../services/PushNotificationsFcmService'
import { sendFcmPushNotification } from '../PushNotificationEvent'

describe('push token lifecycle', () => {
  const send = vi.fn()
  const repository = { findById: vi.fn(), findSingleByQuery: vi.fn(), update: vi.fn() }
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
  const snapshot = { id: 'record', deviceToken: 'old-token', devicePlatform: 'android', firebaseProjectId: undefined }
  let current: any

  beforeEach(() => {
    vi.resetAllMocks()
    current = { ...snapshot }
    firebaseApps.clear()
    firebaseApps.set('first', { messaging: () => ({ send }) } as any)
    firebaseApps.set('second', { messaging: () => ({ send }) } as any)
    repository.findById.mockImplementation(async () => current)
    repository.findSingleByQuery.mockImplementation(async () => current)
    vi.spyOn(config, 'get').mockReturnValue('notification')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    firebaseApps.clear()
  })

  it('clears an unregistered token and its platform', async () => {
    send.mockRejectedValue({ code: 'messaging/registration-token-not-registered' })

    await sendFcmPushNotification({} as any, repository as any, snapshot as any, logger as any)

    expect(current.deviceToken).toBeNull()
    expect(current.devicePlatform).toBeNull()
    expect(repository.update).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not clear a newer registered token', async () => {
    current.deviceToken = 'new-token'
    send.mockRejectedValue({ code: 'messaging/registration-token-not-registered' })

    await sendFcmPushNotification({} as any, repository as any, snapshot as any, logger as any)

    expect(repository.update).not.toHaveBeenCalled()
    expect(current.deviceToken).toBe('new-token')
  })

  it('does not persist a stale snapshot after a successful send', async () => {
    current.deviceToken = 'new-token'
    send.mockResolvedValue('sent')

    await sendFcmPushNotification({} as any, repository as any, { ...snapshot } as any, logger as any)

    expect(repository.update).not.toHaveBeenCalled()
    expect(current.deviceToken).toBe('new-token')
  })

  it('tries another project after the cached project fails', async () => {
    send.mockRejectedValueOnce(new Error('cached project failed')).mockResolvedValueOnce('sent')

    expect(
      await sendFcmPushNotification(
        {} as any,
        repository as any,
        { ...snapshot, firebaseProjectId: 'first' } as any,
        logger as any
      )
    ).toBe('sent')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('updates platform-only registrations without discarding the cached project', async () => {
    current.firebaseProjectId = 'first'
    const service = new PushNotificationsFcmService(repository as any, {} as any, logger as any)

    await service.processSetDeviceInfo({
      agentContext: {},
      assertReadyConnection: () => ({ id: 'connection' }),
      message: { deviceToken: 'old-token', devicePlatform: 'ios' },
    } as any)

    expect(current.devicePlatform).toBe('ios')
    expect(current.firebaseProjectId).toBe('first')
    expect(repository.update).toHaveBeenCalledTimes(1)
  })
})

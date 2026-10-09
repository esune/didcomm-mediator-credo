import { MessageForwardingStrategy } from '@credo-ts/core/build/modules/routing/MessageForwardingStrategy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import config from '../../../config'
import { sendFcmPushNotification } from '../events/PushNotificationEvent'
import { firebaseApps, initializeFirebase } from '../firebase'

vi.mock('firebase-admin', () => ({
  default: {
    credential: { cert: vi.fn() },
    initializeApp: vi.fn(() => ({})),
  },
}))

vi.mock('../events/PushNotificationEvent', () => ({ sendFcmPushNotification: vi.fn() }))

describe('queued-message notification listener', () => {
  const getRecord = vi.fn()
  const repository = {}
  const agent = {
    context: {},
    config: { logger: { info: vi.fn(), error: vi.fn() } },
    events: { on: vi.fn() },
    modules: { pushNotificationsFcm: { getPushNotificationRecordByConnectionId: getRecord } },
    dependencyManager: { resolve: vi.fn(() => repository) },
  }
  let settings: Record<string, unknown>

  beforeEach(() => {
    vi.resetAllMocks()
    firebaseApps.clear()
    settings = {
      'agent:usePushNotifications': true,
      'agent:pickup:strategy': MessageForwardingStrategy.QueueAndLiveModeDelivery,
      'agent:pickup:type': 'postgres',
      'agent:firebase': [{ projectId: 'project', clientEmail: 'email', privateKey: 'key' }],
    }
    vi.spyOn(config, 'get').mockImplementation((key?: string) => (key ? settings[key] : undefined))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    firebaseApps.clear()
  })

  it('contains rejected token lookups', async () => {
    const error = new Error('storage unavailable')
    getRecord.mockRejectedValueOnce(error)
    await initializeFirebase(agent as any)
    const listener = agent.events.on.mock.calls[0][1]

    await expect(listener({ payload: { message: { connectionId: 'connection' } } })).resolves.toBeUndefined()

    expect(agent.config.logger.error).toHaveBeenCalledWith('Error handling queued-message push notification', {
      cause: error,
    })
    expect(sendFcmPushNotification).not.toHaveBeenCalled()
  })

  it('contains rejected notification sends', async () => {
    const error = new Error('send unavailable')
    getRecord.mockResolvedValueOnce({ deviceToken: 'token' })
    vi.mocked(sendFcmPushNotification).mockRejectedValueOnce(error)
    await initializeFirebase(agent as any)
    const listener = agent.events.on.mock.calls[0][1]

    await expect(listener({ payload: { message: { connectionId: 'connection' } } })).resolves.toBeUndefined()

    expect(agent.config.logger.error).toHaveBeenCalledWith('Error handling queued-message push notification', {
      cause: error,
    })
  })

  it('does not send without a device token', async () => {
    getRecord.mockResolvedValueOnce(null)
    await initializeFirebase(agent as any)
    const listener = agent.events.on.mock.calls[0][1]

    await listener({ payload: { message: { connectionId: 'connection' } } })

    expect(sendFcmPushNotification).not.toHaveBeenCalled()
  })

  it.each([MessageForwardingStrategy.QueueOnly, MessageForwardingStrategy.DirectDelivery])(
    'preserves listener registration for strategy %s',
    async (strategy) => {
      settings['agent:pickup:strategy'] = strategy

      await initializeFirebase(agent as any)

      expect(agent.events.on).not.toHaveBeenCalled()
    }
  )

  it('does not register a listener for default storage', async () => {
    settings['agent:pickup:type'] = undefined

    await initializeFirebase(agent as any)

    expect(agent.events.on).not.toHaveBeenCalled()
  })

  it('does not register a listener when push is disabled', async () => {
    settings['agent:usePushNotifications'] = false

    await initializeFirebase(agent as any)

    expect(agent.events.on).not.toHaveBeenCalled()
  })
})

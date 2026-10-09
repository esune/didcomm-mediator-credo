import { AgentContext } from '@credo-ts/core'
import config from '../../../config'
import { Logger } from '../../../logger'
import { firebaseApps } from '../firebase'
import { PushNotificationsFcmRecord, PushNotificationsFcmRepository } from '../repository'

const filterAppsByProjectId = (projectId: string | undefined) => {
  if (firebaseApps.size === 0) return undefined
  const app = projectId ? firebaseApps.get(projectId) : undefined
  return projectId && app
    ? new Map([[projectId, app], ...[...firebaseApps].filter(([id]) => id !== projectId)])
    : firebaseApps
}

type FirebaseLikeError = {
  code: string
}

const isFirebaseLikeError = (error: unknown) =>
  error &&
  typeof error === 'object' &&
  error !== null &&
  typeof (error as FirebaseLikeError).code === 'string' &&
  /(app|auth|messaging|storage|firestore|database)\//.test((error as FirebaseLikeError).code)

const updateRegistration = async (
  agentContext: AgentContext,
  repository: PushNotificationsFcmRepository,
  snapshot: PushNotificationsFcmRecord,
  update: (record: PushNotificationsFcmRecord) => void
) => {
  const current = await repository.findById(agentContext, snapshot.id)
  if (!current || current.deviceToken !== snapshot.deviceToken) return false
  update(current)
  await repository.update(agentContext, current)
  return true
}

export const sendFcmPushNotification = async (
  agentContext: AgentContext,
  repository: PushNotificationsFcmRepository,
  pushNotificationRecord: PushNotificationsFcmRecord,
  logger: Logger
) => {
  const title = config.get('agent:pushNotificationTitle')
  const body = config.get('agent:pushNotificationBody')

  if (!title || !body) {
    logger.warn('Push notification title or body is missing in configuration')
    return
  }

  if (pushNotificationRecord.deviceToken === null) {
    logger.warn('Device token is null, cannot send push notification')
    return
  }

  // Try to send using the specified projectId first
  const filteredFirebaseApps = filterAppsByProjectId(pushNotificationRecord.firebaseProjectId)
  if (!filteredFirebaseApps) {
    logger.warn(`No Firebase app found for projectId: ${pushNotificationRecord.firebaseProjectId}`)
    return
  }

  // If attempt fails or no projectId specified, try all available firebase apps
  for (const [projectId, firebase] of filteredFirebaseApps) {
    let response: string
    try {
      logger.debug(`Sending push notification using Firebase projectId: ${projectId}`)
      response = await firebase.messaging().send({
        token: pushNotificationRecord.deviceToken,
        notification: {
          title,
          body,
        },
      })
    } catch (error) {
      if ((error as FirebaseLikeError)?.code === 'messaging/registration-token-not-registered') {
        try {
          await updateRegistration(agentContext, repository, pushNotificationRecord, (current) => {
            current.deviceToken = null
            current.devicePlatform = null
            current.firebaseProjectId = undefined
          })
        } catch (cleanupError) {
          logger.error('Failed to clear invalid push token', { cause: cleanupError })
        }
        return
      }
      if (isFirebaseLikeError(error)) {
        logger.debug('Error sending notification', { cause: error })
      } else {
        logger.error('Unexpected error sending push notification', { cause: error })
      }
      continue
    }
    if (!response) continue
    logger.info('Push notification sent successfully', { projectId, response })
    if (pushNotificationRecord.firebaseProjectId !== projectId) {
      try {
        const updated = await updateRegistration(agentContext, repository, pushNotificationRecord, (current) => {
          current.firebaseProjectId = projectId
        })
        if (updated) {
          pushNotificationRecord.firebaseProjectId = projectId
        }
      } catch (error) {
        logger.error('Error persisting Firebase project after successful push notification', { cause: error })
      }
    }
    return response
  }
}

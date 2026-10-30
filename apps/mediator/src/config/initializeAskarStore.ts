import { AskarStoreDuplicateError, AskarStoreNotFoundError } from '@credo-ts/askar'
import type { Logger } from '@credo-ts/core'

export async function initializeAskarStore(
  askar: { openStore(): Promise<void>; provisionStore(): Promise<void> },
  logger: Logger
): Promise<void> {
  try {
    await askar.openStore()
    logger.info('Opened existing store')
    return
  } catch (error) {
    if (!(error instanceof AskarStoreNotFoundError)) throw error
  }

  try {
    await askar.provisionStore()
    logger.info('Provisioned store')
  } catch (error) {
    if (!(error instanceof AskarStoreDuplicateError)) throw error
    await askar.openStore()
    logger.info('Opened store provisioned by another instance')
  }
}

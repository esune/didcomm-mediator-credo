import { AskarStoreDuplicateError, AskarStoreInvalidKeyError, AskarStoreNotFoundError } from '@credo-ts/askar'
import { ConsoleLogger, LogLevel } from '@credo-ts/core'
import { expect, test, vi } from 'vitest'
import { initializeAskarStore } from '../config/initializeAskarStore.js'

const logger = new ConsoleLogger(LogLevel.Off)

test('opens an existing store without provisioning', async () => {
  const askar = { openStore: vi.fn().mockResolvedValue(undefined), provisionStore: vi.fn() }
  await initializeAskarStore(askar, logger)
  expect(askar.openStore).toHaveBeenCalledOnce()
  expect(askar.provisionStore).not.toHaveBeenCalled()
})

test('provisions only when opening reports a missing store', async () => {
  const askar = {
    openStore: vi.fn().mockRejectedValue(new AskarStoreNotFoundError('missing')),
    provisionStore: vi.fn().mockResolvedValue(undefined),
  }
  await initializeAskarStore(askar, logger)
  expect(askar.provisionStore).toHaveBeenCalledOnce()
})

test('reopens when another replica provisions the store first', async () => {
  const askar = {
    openStore: vi.fn().mockRejectedValueOnce(new AskarStoreNotFoundError('missing')).mockResolvedValueOnce(undefined),
    provisionStore: vi.fn().mockRejectedValue(new AskarStoreDuplicateError('already exists')),
  }
  await initializeAskarStore(askar, logger)
  expect(askar.openStore).toHaveBeenCalledTimes(2)
})

test.each([
  new AskarStoreInvalidKeyError('invalid key'),
  new Error('connection refused'),
])('does not provision or swallow opening failure: %s', async (error) => {
  const askar = { openStore: vi.fn().mockRejectedValue(error), provisionStore: vi.fn() }
  await expect(initializeAskarStore(askar, logger)).rejects.toBe(error)
  expect(askar.provisionStore).not.toHaveBeenCalled()
})

test('propagates provisioning failures', async () => {
  const error = new Error('permission denied')
  const askar = {
    openStore: vi.fn().mockRejectedValue(new AskarStoreNotFoundError('missing')),
    provisionStore: vi.fn().mockRejectedValue(error),
  }
  await expect(initializeAskarStore(askar, logger)).rejects.toBe(error)
})

test('propagates a failed reopen after concurrent provisioning', async () => {
  const error = new AskarStoreInvalidKeyError('invalid key')
  const askar = {
    openStore: vi.fn().mockRejectedValueOnce(new AskarStoreNotFoundError('missing')).mockRejectedValueOnce(error),
    provisionStore: vi.fn().mockRejectedValue(new AskarStoreDuplicateError('already exists')),
  }
  await expect(initializeAskarStore(askar, logger)).rejects.toBe(error)
})

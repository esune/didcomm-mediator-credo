import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueueRetention } from '../src/MessageQueueRetention'

describe('message retention configuration and lifecycle', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    { messageTtlDays: -1 },
    { messageTtlDays: '30' },
    { messageTtlDays: 1.5 },
    { cleanupIntervalSeconds: 0 },
    { cleanupIntervalSeconds: 2147484 },
    { cleanupBatchSize: 0 },
    { cleanupBatchSize: 10001 },
    { cleanupBatchSize: Number.NaN },
  ])('rejects invalid settings %j', (options) => {
    expect(() => new MessageQueueRetention(options as any)).toThrow('must be an integer')
  })

  it('does not schedule or access the database when retention is disabled', async () => {
    vi.useFakeTimers()
    const retention = new MessageQueueRetention({ messageTtlDays: 0 })
    const pool = { connect: vi.fn() }

    retention.start(pool as any)
    await vi.advanceTimersByTimeAsync(120000)
    expect(await retention.cleanup(pool as any)).toBe(0)
    await retention.stop()

    expect(pool.connect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the default interval and cancels the timer on shutdown', async () => {
    vi.useFakeTimers()
    const retention = new MessageQueueRetention({})
    const cleanup = vi.spyOn(retention, 'cleanup').mockResolvedValue(0)

    retention.start({} as any)
    retention.start({} as any)
    await vi.advanceTimersByTimeAsync(60000)
    expect(cleanup).toHaveBeenCalledTimes(2)
    await retention.stop()
    await vi.advanceTimersByTimeAsync(60000)

    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not overlap cleanup runs and waits for the active run on shutdown', async () => {
    vi.useFakeTimers()
    const retention = new MessageQueueRetention({ cleanupIntervalSeconds: 1 })
    let complete: ((count: number) => void) | undefined
    const cleanup = vi.spyOn(retention, 'cleanup').mockReturnValue(
      new Promise((resolve) => {
        complete = resolve
      })
    )
    retention.start({} as any)
    await vi.advanceTimersByTimeAsync(3000)
    const stopped = retention.stop()

    expect(cleanup).toHaveBeenCalledTimes(1)
    complete?.(0)
    await stopped
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains background failures and retries at the next interval', async () => {
    vi.useFakeTimers()
    const logger = { error: vi.fn() }
    const retention = new MessageQueueRetention({}, logger as any)
    const error = new Error('database unavailable')
    const cleanup = vi.spyOn(retention, 'cleanup').mockRejectedValueOnce(error).mockResolvedValue(0)

    retention.start({} as any)
    await vi.advanceTimersByTimeAsync(60000)
    await retention.stop()

    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith('[retention] Failed to clean up expired queued messages', {
      cause: error,
    })
  })
})

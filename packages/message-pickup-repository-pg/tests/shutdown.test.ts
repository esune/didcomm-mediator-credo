import { describe, expect, it, vi } from 'vitest'
import { PostgresMessagePickupRepository } from '../src/PostgresMessagePickupRepository'

describe('pickup shutdown', () => {
  const setup = () => {
    const repository = new PostgresMessagePickupRepository({
      postgresHost: 'host',
      postgresUser: 'user',
      postgresPassword: 'password',
    })
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn() }
    const listener = { close: vi.fn() }
    Object.assign(repository, { messagesCollection: pool, pubSubInstance: listener, instanceName: 'local-instance' })
    return { repository, pool, listener }
  }

  it('removes only local presence and closes every connection once', async () => {
    const { repository, pool, listener } = setup()

    await Promise.all([repository.shutdown(), repository.shutdown()])

    expect(pool.query).toHaveBeenCalledWith('DELETE FROM live_session WHERE instance = $1', ['local-instance'])
    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(listener.close).toHaveBeenCalledTimes(1)
    expect(await repository.isReady()).toBe(false)
  })

  it('closes pool and Pub/Sub even if presence cleanup fails', async () => {
    const { repository, pool, listener } = setup()
    pool.query.mockRejectedValue(new Error('database offline'))

    await expect(repository.shutdown()).rejects.toThrow('database offline')

    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(listener.close).toHaveBeenCalledTimes(1)
  })

  it('marks database failures as not ready', async () => {
    const { repository, pool } = setup()

    expect(await repository.isReady()).toBe(true)
    pool.query.mockRejectedValue(new Error('database offline'))
    expect(await repository.isReady()).toBe(false)
  })
})

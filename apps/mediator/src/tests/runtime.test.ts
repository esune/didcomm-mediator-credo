import { describe, expect, it, vi } from 'vitest'
import { createShutdownTask, isAgentReady } from '../runtime'

describe('mediator runtime lifecycle', () => {
  it('shuts down once even when several signals arrive', async () => {
    const agent = vi.fn().mockResolvedValue(undefined)
    const pickup = vi.fn().mockResolvedValue(undefined)
    const shutdown = createShutdownTask(agent, pickup)

    await Promise.all([shutdown(), shutdown(), shutdown()])

    expect(agent).toHaveBeenCalledTimes(1)
    expect(pickup).toHaveBeenCalledTimes(1)
  })

  it('closes pickup resources even if agent shutdown fails', async () => {
    const agent = vi.fn().mockRejectedValue(new Error('agent failed'))
    const pickup = vi.fn().mockResolvedValue(undefined)

    await expect(createShutdownTask(agent, pickup)()).rejects.toThrow('agent failed')
    expect(pickup).toHaveBeenCalledTimes(1)
  })

  it('supports default storage without an external pickup repository', async () => {
    const agent = vi.fn().mockResolvedValue(undefined)

    await createShutdownTask(agent)()

    expect(agent).toHaveBeenCalledTimes(1)
  })

  it('reports uninitialized agents as not ready', async () => {
    expect(await isAgentReady({ isInitialized: false } as any)).toBe(false)
  })

  it('checks wallet-backed storage and optional pickup readiness', async () => {
    const findById = vi.fn().mockResolvedValue(null)
    const agent = { isInitialized: true, connections: { findById } }
    const pickup = { isReady: vi.fn().mockResolvedValue(false) }

    expect(await isAgentReady(agent as any)).toBe(true)
    expect(await isAgentReady(agent as any, pickup)).toBe(false)
    expect(findById).toHaveBeenCalledWith('__mediator_readiness__')
  })

  it('reports wallet storage errors as not ready', async () => {
    const agent = {
      isInitialized: true,
      connections: { findById: vi.fn().mockRejectedValue(new Error('db unavailable')) },
    }

    expect(await isAgentReady(agent as any)).toBe(false)
  })
})

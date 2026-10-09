import type { Agent, Logger } from '@credo-ts/core'

export function createShutdownTask(shutdownAgent: () => Promise<void>, shutdownPickup?: () => Promise<void>) {
  let task: Promise<void> | undefined
  return () => {
    task ??= (async () => {
      try {
        await shutdownAgent()
      } finally {
        await shutdownPickup?.()
      }
    })()
    return task
  }
}

export function installShutdownHandlers(shutdown: () => Promise<void>, logger: Logger) {
  let started = false
  const stop = (exitCode: number, error?: unknown) => {
    process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCode)
    if (error) logger.fatal('Fatal mediator error', { cause: error })
    if (started) return
    started = true
    const deadline = setTimeout(() => {
      logger.fatal('Mediator shutdown exceeded its deadline')
      process.exit(1)
    }, 30000)
    deadline.unref()
    void shutdown()
      .then(() => clearTimeout(deadline))
      .catch((cause) => {
        logger.error('Mediator shutdown failed', { cause })
        process.exitCode = 1
      })
  }
  const signal = () => stop(0)
  const fatal = (error: unknown) => stop(1, error)
  process.on('SIGTERM', signal)
  process.on('SIGINT', signal)
  process.on('uncaughtException', fatal)
  process.on('unhandledRejection', fatal)
  return () => {
    process.off('SIGTERM', signal)
    process.off('SIGINT', signal)
    process.off('uncaughtException', fatal)
    process.off('unhandledRejection', fatal)
  }
}

export async function isAgentReady(agent: Agent, pickup?: { isReady(): Promise<boolean> }): Promise<boolean> {
  if (!agent.isInitialized) return false
  try {
    await agent.connections.findById('__mediator_readiness__')
    return pickup ? await pickup.isReady() : true
  } catch {
    return false
  }
}

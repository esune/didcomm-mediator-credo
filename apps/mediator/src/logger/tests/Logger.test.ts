import { LogLevel } from '@credo-ts/core'
import { Logger as TSLogger } from 'tslog'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../Logger'

describe('Logger', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['test', 'trace', 'debug'] as const)('does not serialize suppressed %s data', (level) => {
    const logger = new Logger(LogLevel.info)
    const toJSON = vi.fn(() => {
      throw new Error('Suppressed data must not be serialized')
    })

    expect(() => logger[level]('message', { toJSON })).not.toThrow()
    expect(toJSON).not.toHaveBeenCalled()
  })

  it.each(['test', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const)(
    'does not serialize %s data when logging is off',
    (level) => {
      const logger = new Logger(LogLevel.off)
      const toJSON = vi.fn(() => {
        throw new Error('Disabled data must not be serialized')
      })

      expect(() => logger[level]('message', { toJSON })).not.toThrow()
      expect(toJSON).not.toHaveBeenCalled()
    }
  )

  it('preserves enabled messages and error details', () => {
    const info = vi.spyOn(TSLogger.prototype, 'info').mockReturnValue({} as never)
    const logger = new Logger(LogLevel.info)
    const error = new Error('failure')

    logger.info('message', { error })

    expect(info).toHaveBeenCalledWith('message', {
      error: expect.objectContaining({ message: 'failure', stack: error.stack }),
    })
  })

  it('honors changes to the configured severity', () => {
    const debug = vi.spyOn(TSLogger.prototype, 'debug').mockReturnValue({} as never)
    const logger = new Logger(LogLevel.debug)
    logger.logLevel = LogLevel.warn

    logger.debug('suppressed')

    expect(debug).not.toHaveBeenCalled()
  })

  it('does not throw for circular SDK error contexts or bigint fields', () => {
    const warn = vi.spyOn(TSLogger.prototype, 'warn').mockReturnValue({} as never)
    const logger = new Logger(LogLevel.warn)
    const context: Record<string, unknown> = { count: BigInt(1) }
    context.self = context
    const error = Object.assign(new Error('delivery failed'), { context })

    expect(() => logger.warn('failure', { cause: error })).not.toThrow()
    expect(warn).toHaveBeenCalledWith('failure', {
      cause: expect.objectContaining({ context: { count: '1', self: '[Circular]' } }),
    })
  })

  it('redacts credential fields in SDK contexts', () => {
    const info = vi.spyOn(TSLogger.prototype, 'info').mockReturnValue({} as never)
    const logger = new Logger(LogLevel.info)

    logger.info('context', {
      walletConfig: { key: 'wallet-secret', password: 'database-secret' },
      deviceToken: 'token',
    })

    expect(info).toHaveBeenCalledWith('context', {
      walletConfig: { key: '[REDACTED]', password: '[REDACTED]' },
      deviceToken: '[REDACTED]',
    })
  })

  it('does not let failing serialization interrupt message processing', () => {
    const error = vi.spyOn(TSLogger.prototype, 'error').mockReturnValue({} as never)
    const logger = new Logger(LogLevel.error)

    expect(() =>
      logger.error('failure', {
        toJSON: () => {
          throw new Error('cannot serialize')
        },
      })
    ).not.toThrow()

    expect(error).toHaveBeenCalledWith('failure', { logDataSerializationFailed: true })
  })
})

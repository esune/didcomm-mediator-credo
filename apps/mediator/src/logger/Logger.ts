import { BaseLogger, LogLevel } from '@credo-ts/core'
import { Logger as TSLogger } from 'tslog'

import { replaceError } from './replaceError'

export class Logger extends BaseLogger {
  private logger: TSLogger

  // Map our log levels to tslog levels
  private tsLogLevelMap = {
    [LogLevel.test]: 'silly',
    [LogLevel.trace]: 'trace',
    [LogLevel.debug]: 'debug',
    [LogLevel.info]: 'info',
    [LogLevel.warn]: 'warn',
    [LogLevel.error]: 'error',
    [LogLevel.fatal]: 'fatal',
  } as const

  public constructor(logLevel: LogLevel) {
    super(logLevel)

    this.logger = new TSLogger({
      name: 'Mediator Agent',
      minLevel: this.logLevel === LogLevel.off ? 'fatal' : this.tsLogLevelMap[this.logLevel],
      ignoreStackLevels: 5,
    })
  }

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private log(level: Exclude<LogLevel, LogLevel.off>, message: string, data?: Record<string, any>): void {
    const tsLogLevel = this.tsLogLevelMap[level]

    if (!this.isEnabled(level)) return

    if (data) {
      let safeData: unknown
      try {
        const seen = new WeakSet<object>()
        safeData = JSON.parse(
          JSON.stringify(data, (key, value) => {
            if (/password|secret|private[-_]?key|authorization|token/i.test(key) || key.toLowerCase() === 'key') {
              return '[REDACTED]'
            }
            if (typeof value === 'bigint') return value.toString()
            if (value && typeof value === 'object') {
              if (seen.has(value)) return '[Circular]'
              seen.add(value)
            }
            return replaceError(key, value)
          }) ?? '{}'
        )
      } catch {
        safeData = { logDataSerializationFailed: true }
      }
      this.logger[tsLogLevel](message, safeData)
    } else {
      this.logger[tsLogLevel](message)
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  public test(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.test, message, data)
  }

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  public trace(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.trace, message, data)
  }

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  public debug(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.debug, message, data)
  }

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  public info(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.info, message, data)
  }

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  public warn(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.warn, message, data)
  }

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  public error(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.error, message, data)
  }

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  public fatal(message: string, data?: Record<string, any>): void {
    this.log(LogLevel.fatal, message, data)
  }
}

import { LogLevel } from '@credo-ts/core'
import { describe, expect, it } from 'vitest'
import { parseLogLevel } from '../Logger'

describe('log level configuration', () => {
  it.each([
    [undefined, LogLevel.debug],
    ['info', LogLevel.info],
    ['3', LogLevel.info],
    ['off', LogLevel.off],
    ['7', LogLevel.off],
    [' DEBUG ', LogLevel.debug],
    [0, LogLevel.test],
  ] as const)('normalizes %s', (value, expected) => {
    expect(parseLogLevel(value)).toBe(expected)
  })

  it.each(['invalid', '', '-1', '8', '1.5'])('rejects %s', (value) => {
    expect(() => parseLogLevel(value)).toThrow('LOG_LEVEL')
  })
})

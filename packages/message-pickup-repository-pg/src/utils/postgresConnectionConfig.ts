import { isIP } from 'node:net'
import type { PoolConfig } from 'pg'
import type { PostgresMessagePickupRepositoryConfig } from '../interfaces'

export function postgresConnectionConfig(options: PostgresMessagePickupRepositoryConfig): PoolConfig {
  const rawHost = options.postgresHost
  const address = rawHost.startsWith('/')
    ? undefined
    : new URL(`postgres://${isIP(rawHost) === 6 ? `[${rawHost}]` : rawHost}`)
  if (address && (address.username || address.password || (address.pathname && address.pathname !== '/'))) {
    throw new Error('postgresHost must contain only a hostname and optional port')
  }
  const host = address?.hostname.startsWith('[') ? address.hostname.slice(1, -1) : (address?.hostname ?? rawHost)
  const port = options.postgresPort ?? Number(address?.port || 5432)
  const max = options.postgresMaxConnections ?? 10
  const connectionTimeoutMillis = options.postgresConnectionTimeoutMillis ?? 10000
  const statementTimeout = options.postgresStatementTimeoutMillis ?? 30000
  for (const [name, value, minimum, maximum] of [
    ['postgresPort', port, 1, 65535],
    ['postgresMaxConnections', max, 1, 1000],
    ['postgresConnectionTimeoutMillis', connectionTimeoutMillis, 0, 2147483647],
    ['postgresStatementTimeoutMillis', statementTimeout, 0, 2147483647],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
    }
  }
  return {
    host,
    user: options.postgresUser,
    password: options.postgresPassword,
    database: options.postgresDatabaseName || 'messagepickuprepository',
    port,
    max,
    connectionTimeoutMillis,
    statement_timeout: statementTimeout,
  }
}

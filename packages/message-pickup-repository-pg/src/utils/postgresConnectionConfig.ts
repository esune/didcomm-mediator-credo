import type { PoolConfig } from 'pg'
import type { PostgresMessagePickupRepositoryConfig } from '../interfaces'

export function postgresConnectionConfig(options: PostgresMessagePickupRepositoryConfig): PoolConfig {
  const port = options.postgresPort ?? 5432
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
    host: options.postgresHost,
    user: options.postgresUser,
    password: options.postgresPassword,
    database: options.postgresDatabaseName || 'messagepickuprepository',
    port,
    max,
    connectionTimeoutMillis,
    statement_timeout: statementTimeout,
  }
}

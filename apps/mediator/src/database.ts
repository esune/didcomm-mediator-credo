import type { AskarWalletPostgresStorageConfig } from '@credo-ts/askar/build/wallet'
import config from './config'

export const askarPostgresConfig: AskarWalletPostgresStorageConfig = {
  // AskarWalletPostgresStorageConfig defines interface
  // for the Postgres plugin configuration.
  type: 'postgres',
  config: {
    host: config.get('db:host') as string,
    connectTimeout: 10,
    maxConnections: config.get('db:maxConnections') as number | undefined,
    idleTimeout: config.get('db:idleTimeout') as number | undefined,
  },
  credentials: {
    account: config.get('db:user') as string,
    password: config.get('db:password') as string,
    adminAccount: config.get('db:adminUser') as string,
    adminPassword: config.get('db:adminPassword') as string,
  },
}

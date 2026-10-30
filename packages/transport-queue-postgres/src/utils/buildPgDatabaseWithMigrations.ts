import fs from 'node:fs'
import path from 'node:path'
import { Logger } from '@credo-ts/core'
import { Client, Pool, type PoolClient } from 'pg'

const MIGRATION_ADVISORY_LOCK_KEY = 814200383

/**
 * Runs all pending SQL migrations in a target PostgreSQL database.
 * - Automatically creates the database if it does not exist.
 * - Uses the `postgres` maintenance database to check/create the target database.
 * - Applies versioned `.sql` files from a directory.
 *
 * @param logger - Optional Credo-compatible logger instance
 * @param postgresConfig - Connection config to connect as superuser (to create DB if needed).
 * @param targetDatabase - Name of the target database to migrate.
 * @param migrationsDir - Directory where migration `.sql` files are located.
 */
export async function buildPgDatabaseWithMigrations(
  logger: Logger | undefined,
  postgresConfig: { user: string; password: string; host: string; port?: number },
  targetDatabase: string,
  migrationsDir: string = path.resolve(import.meta.dirname, '../../migrations')
): Promise<void> {
  const adminClient = new Client({ ...postgresConfig, database: 'postgres' })

  try {
    await adminClient.connect()

    // Try to create the target database if it doesn't exist
    const existsResult = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDatabase])

    if (existsResult.rowCount === 0) {
      await adminClient.query(`CREATE DATABASE ${targetDatabase}`)
      logger?.info(`[migration] Database "${targetDatabase}" created.`)
    } else {
      logger?.info(`[migration] Database "${targetDatabase}" already exists.`)
    }
  } catch (error) {
    logger?.error(`[migration] Failed to create database "${targetDatabase}": ${(error as Error).message}`)
    try {
      await adminClient.end()
    } catch (cleanupError) {
      logger?.error(`[migration] Failed to close maintenance connection: ${String(cleanupError)}`)
    }
    throw error
  }
  await adminClient.end()

  // Now connect to the target database using a pool
  const pool = new Pool({ ...postgresConfig, database: targetDatabase })

  let client: PoolClient | undefined
  let transactionOpen = false
  const errors: unknown[] = []

  try {
    if (!fs.statSync(migrationsDir).isDirectory()) {
      throw new Error(`Migrations path is not a directory: ${migrationsDir}`)
    }
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => /^\d{3,}-[\w-]+\.sql$/.test(file))
      .sort()
    if (files.length === 0) throw new Error(`No SQL migrations found in ${migrationsDir}`)

    client = await pool.connect()
    await client.query('BEGIN')
    transactionOpen = true
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY])

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id SERIAL PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at TIMESTAMP DEFAULT now()
      )
    `)

    const result = await client.query('SELECT version FROM schema_version ORDER BY id DESC LIMIT 1')
    const currentVersion = result.rows.length > 0 ? result.rows[0].version : 0
    logger?.info(`[migration] Current schema version: ${currentVersion}`)

    for (const file of files) {
      const versionMatch = file.match(/^(\d{3,})-/)
      if (!versionMatch) {
        logger?.warn(`[migration] Skipping invalid filename: ${file}`)
        continue
      }

      const version = Number.parseInt(versionMatch[1], 10)
      if (version <= currentVersion) {
        logger?.debug(`[migration] Skipping already applied: ${file}`)
        continue
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')
      logger?.info(`[migration] Applying migration: ${file}`)

      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_version (version) VALUES ($1)', [version])
        logger?.info(`[migration] Applied successfully: ${file}`)
      } catch (fileErr) {
        throw new Error(`[migration] Failed to apply ${file}: ${(fileErr as Error).message}`)
      }
    }

    await client.query('COMMIT')
    transactionOpen = false
  } catch (err) {
    errors.push(err)
    logger?.error(`[migration] Migration process failed: ${String(err)}`)
    if (transactionOpen && client) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        errors.push(rollbackError)
        logger?.error(`[migration] Rollback failed: ${String(rollbackError)}`)
      }
    }
  } finally {
    try {
      client?.release(errors.length > 0)
    } catch (releaseError) {
      errors.push(releaseError)
      logger?.error(`[migration] Failed to release migration connection: ${String(releaseError)}`)
    }
    try {
      await pool.end()
    } catch (cleanupError) {
      errors.push(cleanupError)
      logger?.error(`[migration] Failed to close migration pool: ${String(cleanupError)}`)
    }
  }
  if (errors.length > 0) throw errors[0]
}

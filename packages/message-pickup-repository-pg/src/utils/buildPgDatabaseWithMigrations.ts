import fs from 'node:fs'
import path from 'node:path'
import { Logger } from '@credo-ts/core'
import { Client, Pool, type PoolClient, escapeIdentifier } from 'pg'

/**
 * Runs all pending SQL migrations in a target PostgreSQL database.
 * - Automatically creates the database if it does not exist.
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
  migrationsDir: string = path.resolve(__dirname, '../migrations')
): Promise<void> {
  if (!fs.existsSync(migrationsDir)) throw new Error(`Migrations directory not found: ${migrationsDir}`)
  const adminClient = new Client(postgresConfig)

  try {
    await adminClient.connect()
    await adminClient.query('SELECT pg_advisory_lock(hashtext($1))', [`credo:pickup:database:${targetDatabase}`])

    // Try to create the target database if it doesn't exist
    const existsResult = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDatabase])

    if (existsResult.rowCount === 0) {
      await adminClient.query(`CREATE DATABASE ${escapeIdentifier(targetDatabase)}`)
      logger?.info(`[migration] Database "${targetDatabase}" created.`)
    } else {
      logger?.info(`[migration] Database "${targetDatabase}" already exists.`)
    }
  } catch (error) {
    logger?.error(`[migration] Failed to create database "${targetDatabase}": ${(error as Error).message}`)
    throw error
  } finally {
    await adminClient.end()
  }

  // Now connect to the target database using a pool
  const pool = new Pool({ ...postgresConfig, database: targetDatabase })

  let client: PoolClient | undefined

  try {
    client = await pool.connect()
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('credo:pickup:migrations'))")

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id SERIAL PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at TIMESTAMP DEFAULT now()
      )
    `)

    const result = await client.query('SELECT version FROM schema_version')
    const appliedVersions = new Set<number>(result.rows.map((row) => row.version))

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => /^\d{3,}-[\w\-]+\.sql$/.test(file))
      .sort()

    for (const file of files) {
      const versionMatch = file.match(/^(\d{3,})-/)
      if (!versionMatch) {
        logger?.warn(`[migration] Skipping invalid filename: ${file}`)
        continue
      }

      const version = Number.parseInt(versionMatch[1], 10)
      if (appliedVersions.has(version)) {
        logger?.debug(`[migration] Skipping already applied: ${file}`)
        continue
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')
      logger?.info(`[migration] Applying migration: ${file}`)

      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_version (version) VALUES ($1)', [version])
        appliedVersions.add(version)
        logger?.info(`[migration] Applied successfully: ${file}`)
      } catch (fileErr) {
        throw new Error(`[migration] Failed to apply ${file}: ${(fileErr as Error).message}`)
      }
    }

    await client.query('COMMIT')
  } catch (err) {
    logger?.error(`[migration] Migration process failed: ${(err as Error).message}`)
    if (client) await client.query('ROLLBACK')
    throw err
  } finally {
    client?.release()
    await pool.end()
  }
}

import type { Logger } from '@credo-ts/core'
import type { Pool } from 'pg'
import type { PostgresMessagePickupRepositoryConfig } from './interfaces'

type RetentionConfig = Pick<
  PostgresMessagePickupRepositoryConfig,
  'messageTtlDays' | 'cleanupIntervalSeconds' | 'cleanupBatchSize'
>

export class MessageQueueRetention {
  private readonly messageTtlDays: number
  private readonly cleanupIntervalSeconds: number
  private readonly cleanupBatchSize: number
  private timer?: NodeJS.Timeout
  private inFlight?: Promise<void>

  public constructor(
    options: RetentionConfig,
    private readonly logger?: Logger
  ) {
    this.messageTtlDays = options.messageTtlDays ?? 30
    this.cleanupIntervalSeconds = options.cleanupIntervalSeconds ?? 60
    this.cleanupBatchSize = options.cleanupBatchSize ?? 1000

    for (const [name, value, minimum, maximum] of [
      ['messageTtlDays', this.messageTtlDays, 0, 36500],
      ['cleanupIntervalSeconds', this.cleanupIntervalSeconds, 1, 2147483],
      ['cleanupBatchSize', this.cleanupBatchSize, 1, 10000],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
      }
    }
  }

  public start(pool: Pool): void {
    if (this.timer || this.messageTtlDays === 0) return
    this.timer = setInterval(() => this.run(pool), this.cleanupIntervalSeconds * 1000)
    this.timer.unref()
    this.run(pool)
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight
  }

  public async cleanup(pool: Pool): Promise<number> {
    if (this.messageTtlDays === 0) return 0
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        "SELECT pg_try_advisory_xact_lock(hashtext('credo:message-pickup:retention')) AS acquired"
      )
      let deleted = 0
      if (rows[0].acquired) {
        const result = await client.query(
          `WITH expired_messages AS (
             SELECT id FROM queued_message
             WHERE created_at < now() - ($1 * interval '1 day')
             ORDER BY created_at, id
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           DELETE FROM queued_message AS message
           USING expired_messages
           WHERE message.id = expired_messages.id`,
          [this.messageTtlDays, this.cleanupBatchSize]
        )
        deleted = result.rowCount ?? 0
      }
      await client.query('COMMIT')
      return deleted
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  private run(pool: Pool): void {
    if (this.inFlight) return
    this.inFlight = this.cleanup(pool)
      .then((deleted) => {
        if (deleted) this.logger?.info('[retention] Expired queued messages deleted', { deleted })
      })
      .catch((error) => {
        this.logger?.error('[retention] Failed to clean up expired queued messages', { cause: error })
      })
      .finally(() => {
        this.inFlight = undefined
      })
  }
}

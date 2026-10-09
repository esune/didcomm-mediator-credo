import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MessageQueueRetention } from '../src/MessageQueueRetention'

const connectionString = process.env.PICKUP_TEST_DATABASE_URL

describe.skipIf(!connectionString)('PostgreSQL message retention', () => {
  const schema = `pickup_test_${randomUUID().replace(/-/g, '')}`
  const admin = new Pool({ connectionString })
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` })

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const migration = await readFile(path.join(__dirname, '../src/migrations/001-initial-schema.sql'), 'utf8')
    await pool.query(migration)
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE queued_message')
  })

  afterAll(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  })

  const insert = async (ageDays: number, state = 'pending') => {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO queued_message (id, connection_id, encrypted_message, state, created_at)
       VALUES ($1, $2, $3, $4, now() - ($5 * interval '1 day'))`,
      [id, randomUUID(), { ciphertext: 'message' }, state, ageDays]
    )
    return id
  }

  it('defaults to 30 days and preserves fresh pending and sending messages', async () => {
    await insert(31)
    await insert(31, 'sending')
    const pending = await insert(29)
    const sending = await insert(29, 'sending')

    expect(await new MessageQueueRetention({}).cleanup(pool)).toBe(2)

    const { rows } = await pool.query('SELECT id FROM queued_message')
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([pending, sending]))
  })

  it('supports a custom TTL', async () => {
    await insert(8)
    const fresh = await insert(6)

    expect(await new MessageQueueRetention({ messageTtlDays: 7 }).cleanup(pool)).toBe(1)
    expect((await pool.query('SELECT id FROM queued_message')).rows).toEqual([{ id: fresh }])
  })

  it('never deletes messages when retention is disabled', async () => {
    const id = await insert(365)

    expect(await new MessageQueueRetention({ messageTtlDays: 0 }).cleanup(pool)).toBe(0)
    expect((await pool.query('SELECT id FROM queued_message')).rows).toEqual([{ id }])
  })

  it('limits each sweep to its configured batch size', async () => {
    await insert(31)
    await insert(32)
    await insert(33)
    const retention = new MessageQueueRetention({ cleanupBatchSize: 2 })

    expect(await retention.cleanup(pool)).toBe(2)
    expect(await retention.cleanup(pool)).toBe(1)
    expect(await retention.cleanup(pool)).toBe(0)
  })

  it('does not sweep while another replica owns the advisory lock', async () => {
    const id = await insert(31)
    const locker = await pool.connect()
    try {
      await locker.query('BEGIN')
      await locker.query("SELECT pg_advisory_xact_lock(hashtext('credo:message-pickup:retention'))")

      expect(await new MessageQueueRetention({}).cleanup(pool)).toBe(0)
      expect((await pool.query('SELECT id FROM queued_message')).rows).toEqual([{ id }])
    } finally {
      await locker.query('ROLLBACK')
      locker.release()
    }

    expect(await new MessageQueueRetention({}).cleanup(pool)).toBe(1)
  })
})

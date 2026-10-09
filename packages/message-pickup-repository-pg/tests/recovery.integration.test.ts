import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresMessagePickupRepository } from '../src/PostgresMessagePickupRepository'

const connectionString = process.env.PICKUP_TEST_DATABASE_URL

describe.skipIf(!connectionString)('PostgreSQL delivery recovery', () => {
  const schema = `pickup_test_${randomUUID().replace(/-/g, '')}`
  const admin = new Pool({ connectionString })
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` })
  const options = { postgresHost: 'localhost', postgresUser: 'test', postgresPassword: 'test' }
  const repository = new PostgresMessagePickupRepository(options)
  const agent = {
    messagePickup: { getLiveModeSession: vi.fn(), deliverMessages: vi.fn() },
    events: { emit: vi.fn() },
    context: {},
  }

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    for (const file of [
      '001-initial-schema.sql',
      '002-unique-expiry-live-session-constraint.sql',
      '005-delivery-lease.sql',
    ]) {
      await pool.query(await readFile(path.join(__dirname, '../src/migrations', file), 'utf8'))
    }
    Object.assign(repository, { messagesCollection: pool, agent })
  })

  beforeEach(async () => {
    vi.resetAllMocks()
    await pool.query('TRUNCATE queued_message, live_session')
  })

  afterAll(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  })

  const insert = async (seconds: number, legacy = false) => {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO queued_message (id, connection_id, state, created_at)
       VALUES ($1, $2, 'sending', now() - interval '1 day')`,
      [id, randomUUID()]
    )
    await pool.query(
      "UPDATE queued_message SET sending_at = CASE WHEN $3 THEN NULL ELSE now() - ($2 * interval '1 second') END WHERE id = $1",
      [id, seconds, legacy]
    )
    return id
  }

  it('recovers expired and legacy leases while preserving recent claims', async () => {
    const expired = await insert(301)
    const legacy = await insert(0, true)
    const recent = await insert(10)

    expect(await (repository as any).recoverExpiredDeliveries()).toBe(2)

    const { rows } = await pool.query('SELECT id, state FROM queued_message')
    expect(new Map(rows.map((row) => [row.id, row.state]))).toEqual(
      new Map([
        [expired, 'pending'],
        [legacy, 'pending'],
        [recent, 'sending'],
      ])
    )
  })

  it('timestamps claims made by old-pod SQL and clears released leases', async () => {
    const id = randomUUID()
    await pool.query("INSERT INTO queued_message (id, state) VALUES ($1, 'pending')", [id])
    await pool.query("UPDATE queued_message SET state = 'sending' WHERE id = $1", [id])
    expect(
      (await pool.query('SELECT sending_at FROM queued_message WHERE id = $1', [id])).rows[0].sending_at
    ).toBeInstanceOf(Date)
    await pool.query("UPDATE queued_message SET state = 'pending' WHERE id = $1", [id])
    expect(
      (await pool.query('SELECT sending_at FROM queued_message WHERE id = $1', [id])).rows[0].sending_at
    ).toBeNull()
  })

  it('bounds recovery work per batch', async () => {
    await insert(301)
    await insert(301)
    const bounded = new PostgresMessagePickupRepository({ ...options, recoveryBatchSize: 1 })
    Object.assign(bounded, { messagesCollection: pool })

    expect(await (bounded as any).recoverExpiredDeliveries()).toBe(1)
    expect(await (bounded as any).recoverExpiredDeliveries()).toBe(1)
  })

  it('does not report enqueue failure when a local send fails after insertion', async () => {
    agent.messagePickup.getLiveModeSession.mockResolvedValue({ id: randomUUID() })
    agent.messagePickup.deliverMessages.mockRejectedValue(new Error('socket closed'))

    const id = await repository.addMessage({ connectionId: randomUUID(), recipientDids: [], payload: {} as any })

    expect((await pool.query('SELECT state, sending_at FROM queued_message WHERE id = $1', [id])).rows).toEqual([
      { state: 'pending', sending_at: null },
    ])
  })

  it('still reports genuine insertion failures', async () => {
    await expect(
      repository.addMessage({ connectionId: 'not-a-uuid', recipientDids: [], payload: {} as any })
    ).rejects.toThrow('Failed to add message')
  })

  it('rejects invalid recovery settings', () => {
    expect(() => new PostgresMessagePickupRepository({ ...options, deliveryLeaseSeconds: 0 })).toThrow()
    expect(() => new PostgresMessagePickupRepository({ ...options, recoveryBatchSize: 1.5 })).toThrow()
  })
})

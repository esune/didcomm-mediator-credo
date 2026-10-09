import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresMessagePickupRepository } from '../src/PostgresMessagePickupRepository'

const connectionString = process.env.PICKUP_TEST_DATABASE_URL

describe.skipIf(!connectionString)('PostgreSQL queue claims', () => {
  const schema = `pickup_test_${randomUUID().replace(/-/g, '')}`
  const admin = new Pool({ connectionString })
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 2000 })
  const connectionId = randomUUID()
  const otherConnectionId = randomUUID()
  const repository = new PostgresMessagePickupRepository({
    postgresHost: 'localhost',
    postgresUser: 'test',
    postgresPassword: 'test',
  })
  const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn() }

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const migration = await readFile(path.join(__dirname, '../src/migrations/001-initial-schema.sql'), 'utf8')
    await pool.query(migration)
    Object.assign(repository, { messagesCollection: pool, logger })
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await pool.query('TRUNCATE queued_message')
  })

  afterAll(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  })

  const insertMessage = async (offset: number, owner = connectionId, state = 'pending') => {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO queued_message (id, connection_id, recipient_dids, encrypted_message, state, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, owner, ['did:key:recipient'], { ciphertext: `message-${offset}` }, state, new Date(1700000000000 + offset)]
    )
    return id
  }

  it('does not claim a message twice across concurrent consumers', async () => {
    for (let index = 0; index < 20; index++) await insertMessage(index)

    const batches = await Promise.all(
      Array.from({ length: 20 }, () => repository.takeFromQueue({ connectionId, limit: 1 }))
    )
    const ids = batches.flat().map((message) => message.id)

    expect(ids).toHaveLength(20)
    expect(new Set(ids).size).toBe(20)
    expect(await repository.getAvailableMessageCount({ connectionId })).toBe(0)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each([false, true])('skips locked rows with deleteMessages=%s', async (deleteMessages) => {
    const first = await insertMessage(0)
    const second = await insertMessage(1)
    const locker = await pool.connect()
    try {
      await locker.query('BEGIN')
      await locker.query('SELECT id FROM queued_message WHERE id = $1 FOR UPDATE', [first])

      const messages = await repository.takeFromQueue({ connectionId, limit: 1, deleteMessages })

      expect(messages.map((message) => message.id)).toEqual([second])
      expect(logger.error).not.toHaveBeenCalled()
    } finally {
      await locker.query('ROLLBACK')
      locker.release()
    }
    const messages = await repository.takeFromQueue({ connectionId, limit: 1, deleteMessages })
    expect(messages.map((message) => message.id)).toEqual([first])
  })

  it.each([false, true])('returns oldest messages first with deleteMessages=%s', async (deleteMessages) => {
    const newest = await insertMessage(2)
    const oldest = await insertMessage(0)
    const middle = await insertMessage(1)

    const messages = await repository.takeFromQueue({ connectionId, deleteMessages })

    expect(messages.map((message) => message.id)).toEqual([oldest, middle, newest])
    const { rows } = await pool.query('SELECT state FROM queued_message')
    expect(rows).toHaveLength(deleteMessages ? 0 : 3)
    if (!deleteMessages) expect(rows.every((row) => row.state === 'sending')).toBe(true)
  })

  it('preserves recipient-DID matching across a legacy connection change', async () => {
    const id = await insertMessage(0, otherConnectionId)

    const messages = await repository.takeFromQueue({ connectionId, recipientDid: 'did:key:recipient', limit: 1 })

    expect(messages.map((message) => message.id)).toEqual([id])
  })

  it('only resets sending messages for the disconnected connection', async () => {
    const sending = await insertMessage(0, connectionId, 'sending')
    const pending = await insertMessage(1)
    const otherSending = await insertMessage(2, otherConnectionId, 'sending')

    await (repository as any).checkQueueMessages(connectionId)

    const { rows } = await pool.query('SELECT id, state FROM queued_message')
    expect(new Map(rows.map((row) => [row.id, row.state]))).toEqual(
      new Map([
        [sending, 'pending'],
        [pending, 'pending'],
        [otherSending, 'sending'],
      ])
    )
    expect(logger.error).not.toHaveBeenCalled()
  })
})

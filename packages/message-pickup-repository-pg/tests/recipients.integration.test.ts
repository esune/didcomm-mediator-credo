import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { DidKey, Key, KeyType } from '@credo-ts/core'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresMessagePickupRepository } from '../src/PostgresMessagePickupRepository'

const connectionString = process.env.PICKUP_TEST_DATABASE_URL

describe.skipIf(!connectionString)('authorized recipient pickup', () => {
  const schema = `pickup_test_${randomUUID().replace(/-/g, '')}`
  const admin = new Pool({ connectionString })
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` })
  const connectionId = randomUUID()
  const oldConnectionId = randomUUID()
  const did = new DidKey(Key.fromPublicKey(new Uint8Array(32).fill(1), KeyType.Ed25519)).did
  const registration = vi.fn()
  const repository = new PostgresMessagePickupRepository({
    postgresHost: 'host',
    postgresUser: 'user',
    postgresPassword: 'password',
  })

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(await readFile(path.join(__dirname, '../src/migrations/001-initial-schema.sql'), 'utf8'))
    Object.assign(repository, {
      messagesCollection: pool,
      agent: { context: {}, dependencyManager: { resolve: () => ({ findSingleByQuery: registration }) } },
    })
  })
  beforeEach(async () => {
    registration.mockReset().mockResolvedValue(null)
    await pool.query('TRUNCATE queued_message')
  })
  afterAll(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  })

  const insert = async (owner: string, recipient = did) => {
    const id = randomUUID()
    await pool.query(
      "INSERT INTO queued_message (id, connection_id, recipient_dids, encrypted_message, state) VALUES ($1, $2, $3, $4, 'pending')",
      [id, owner, [recipient], { ciphertext: 'message' }]
    )
    return id
  }

  it('does not expose another connection merely because the caller knows its recipient DID', async () => {
    await insert(oldConnectionId)

    expect(await repository.getAvailableMessageCount({ connectionId, recipientDid: did })).toBe(0)
    expect(await repository.takeFromQueue({ connectionId, recipientDid: did })).toEqual([])
  })

  it('allows registered key reuse and makes acknowledgement delete the claimed row', async () => {
    registration.mockResolvedValue({ connectionId })
    const id = await insert(oldConnectionId)

    expect(await repository.getAvailableMessageCount({ connectionId, recipientDid: did })).toBe(1)
    const messages = await repository.takeFromQueue({ connectionId, recipientDid: did })
    expect(messages.map((message) => message.id)).toEqual([id])
    await repository.removeMessages({ connectionId, messageIds: [id] })

    expect((await pool.query('SELECT id FROM queued_message')).rows).toEqual([])
    expect(registration).toHaveBeenCalledWith({}, expect.objectContaining({ connectionId }))
  })

  it('filters own-connection counts and pickup by the requested recipient', async () => {
    const matching = await insert(connectionId)
    await insert(connectionId, 'did:key:other')

    expect(await repository.getAvailableMessageCount({ connectionId, recipientDid: did })).toBe(1)
    expect((await repository.takeFromQueue({ connectionId, recipientDid: did })).map((message) => message.id)).toEqual([
      matching,
    ])
  })

  it('preserves ordinary unfiltered pickup without querying mediation storage', async () => {
    await insert(connectionId)

    expect(await repository.getAvailableMessageCount({ connectionId })).toBe(1)
    expect(await repository.takeFromQueue({ connectionId })).toHaveLength(1)
    expect(registration).not.toHaveBeenCalled()
  })

  it('reports storage errors rather than returning an empty queue', async () => {
    await expect(repository.getAvailableMessageCount({ connectionId: 'invalid' })).rejects.toThrow()
    await expect(repository.takeFromQueue({ connectionId: 'invalid' })).rejects.toThrow()
  })
})

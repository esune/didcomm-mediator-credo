import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { MessagePickupSessionRole } from '@credo-ts/core/build/modules/message-pickup/MessagePickupSession'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresMessagePickupRepository } from '../src/PostgresMessagePickupRepository'

const connectionString = process.env.PICKUP_TEST_DATABASE_URL

describe.skipIf(!connectionString)('PostgreSQL live-session ownership', () => {
  const schema = `pickup_test_${randomUUID().replace(/-/g, '')}`
  const admin = new Pool({ connectionString })
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` })
  const repository = new PostgresMessagePickupRepository({
    postgresHost: 'localhost',
    postgresUser: 'test',
    postgresPassword: 'test',
  })
  const connectionId = randomUUID()
  const session = () => ({
    id: randomUUID(),
    connectionId,
    protocolVersion: 'v2',
    role: MessagePickupSessionRole.MessageHolder,
  })

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    for (const file of ['001-initial-schema.sql', '002-unique-expiry-live-session-constraint.sql']) {
      await pool.query(await readFile(path.join(__dirname, '../src/migrations', file), 'utf8'))
    }
    Object.assign(repository, { messagesCollection: pool, instanceName: 'local-instance' })
  })
  beforeEach(async () => {
    await pool.query('TRUNCATE live_session')
    ;(repository as any).localSessions.clear()
  })
  afterAll(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  })

  it('allows the same connection on two instances and removes only the owning session', async () => {
    const local = session()
    const remote = session()
    await (repository as any).addLiveSessionOnDb(local, 'local-instance')
    await (repository as any).addLiveSessionOnDb(remote, 'remote-instance')

    await (repository as any).removeLiveSessionOnDb(local.id)
    await (repository as any).removeLiveSessionOnDb(remote.id)

    expect((await pool.query('SELECT session_id FROM live_session')).rows).toEqual([{ session_id: remote.id }])
  })

  it('keeps renewals idempotent and maps database sessions to the API shape', async () => {
    const local = session()
    await (repository as any).addLiveSessionOnDb(local, 'local-instance')
    await (repository as any).addLiveSessionOnDb(local, 'local-instance')

    expect((await pool.query('SELECT session_id FROM live_session')).rowCount).toBe(1)
    expect(await (repository as any).findLiveSessionInDb(connectionId)).toMatchObject({
      id: local.id,
      connectionId,
      protocolVersion: 'v2',
      isLocalSession: false,
    })
  })

  it('renews idle local sessions and cleans abandoned remote presence', async () => {
    const local = session()
    const remote = session()
    await (repository as any).addLiveSessionOnDb(local, 'local-instance')
    await (repository as any).addLiveSessionOnDb(remote, 'remote-instance')
    await pool.query("UPDATE live_session SET expires_at = now() - interval '1 minute'")
    ;(repository as any).localSessions.set(local.id, local)

    await (repository as any).renewLiveSessions()

    expect((await pool.query('SELECT session_id, expires_at > now() AS active FROM live_session')).rows).toEqual([
      { session_id: local.id, active: true },
    ])
  })

  it('serializes a delayed save before removal for the same connection', async () => {
    const order: string[] = []
    let complete: (() => void) | undefined
    const saved = (repository as any).runSessionJob(connectionId, async () => {
      await new Promise<void>((resolve) => {
        complete = resolve
      })
      order.push('saved')
    })
    const removed = (repository as any).runSessionJob(connectionId, async () => {
      order.push('removed')
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    complete?.()
    await Promise.all([saved, removed])

    expect(order).toEqual(['saved', 'removed'])
  })

  it('recreates lost database presence for a healthy local session', async () => {
    const local = session()
    ;(repository as any).localSessions.set(local.id, local)

    await (repository as any).renewLiveSessions()

    expect((await pool.query('SELECT session_id FROM live_session')).rows).toEqual([{ session_id: local.id }])
  })
})

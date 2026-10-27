import {
  AgentContext,
  CacheModuleConfig,
  DidDocumentRole,
  DidRecord,
  DidRepository,
  EventEmitter,
  Kms,
  RecordDuplicateError,
} from '@credo-ts/core'
import {
  DidCommConnectionRecord,
  DidCommConnectionRepository,
  DidCommDidExchangeRole,
  DidCommDidExchangeState,
} from '@credo-ts/didcomm'
import { beforeEach, describe, expect, it } from 'vitest'

// Covers patches/@credo-ts__core@0.7.3.patch and patches/@credo-ts__didcomm@0.7.3.patch

type TagQuery = Record<string, unknown>
type TaggedRecord = { getTags(): object }

function matches(record: TaggedRecord, query: TagQuery) {
  const tags = record.getTags() as Record<string, unknown>
  return Object.entries(query).every(([key, value]) => {
    if (value === undefined) return true
    if (Array.isArray(value)) return value.every((item) => (tags[key] as unknown[] | undefined)?.includes(item))
    return tags[key] === value
  })
}

function fakeStorage(records: TaggedRecord[], queries: TagQuery[]): never {
  return {
    findByQuery: async (_agentContext: AgentContext, _recordClass: unknown, query: TagQuery) => {
      queries.push(query)
      if ('$or' in query || '$and' in query || '$not' in query) throw new Error('Unexpected compound query')
      return records.filter((record) => matches(record, query))
    },
  } as never
}

function fakeAgentContext(cache?: Map<string, unknown>) {
  const cacheModuleConfig = {
    useCachedStorageService: Boolean(cache),
    cache: {
      get: async (_context: AgentContext, key: string) => cache?.get(key) ?? null,
      set: async (_context: AgentContext, key: string, value: unknown) => cache?.set(key, value),
    },
  }
  return {
    resolve: (token: unknown) => {
      if (token === CacheModuleConfig) return cacheModuleConfig
      throw new Error(`Unexpected dependency ${String(token)}`)
    },
  } as unknown as AgentContext
}

const fingerprint = 'z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG'
const recipientKey = { fingerprint } as Kms.PublicJwk

const didRecord = (did: string, role: DidDocumentRole, tags: Record<string, unknown> = {}) =>
  new DidRecord({ did, role, tags: { recipientKeyFingerprints: [fingerprint], ...tags } })

describe('patched DidRepository', () => {
  let records: DidRecord[]
  let queries: TagQuery[]
  let repository: DidRepository
  const agentContext = fakeAgentContext()

  beforeEach(() => {
    records = []
    queries = []
    repository = new DidRepository(fakeStorage(records, queries), {} as EventEmitter)
  })

  it('filters recipient key lookups by role in memory', async () => {
    const created = didRecord('did:peer:created', DidDocumentRole.Created)
    const received = didRecord('did:peer:received', DidDocumentRole.Received)
    records.push(created, received)

    expect(await repository.findReceivedDidByRecipientKey(agentContext, recipientKey)).toBe(received)
    expect(await repository.findCreatedDidByRecipientKey(agentContext, recipientKey)).toBe(created)
    expect(queries).toEqual([{ recipientKeyFingerprints: [fingerprint] }, { recipientKeyFingerprints: [fingerprint] }])
  })

  it('still rejects duplicate recipient key matches for a role', async () => {
    records.push(
      didRecord('did:peer:one', DidDocumentRole.Received),
      didRecord('did:peer:two', DidDocumentRole.Received)
    )

    await expect(repository.findReceivedDidByRecipientKey(agentContext, recipientKey)).rejects.toThrow(
      RecordDuplicateError
    )
  })

  it('finds dids by did or alternative did without a $or query', async () => {
    const byAlternative = didRecord('did:peer:4long', DidDocumentRole.Received, {
      alternativeDids: ['did:peer:4short'],
    })
    const created = didRecord('did:peer:4short', DidDocumentRole.Created)
    records.push(byAlternative, created)

    expect(await repository.findReceivedDid(agentContext, 'did:peer:4short')).toBe(byAlternative)
    expect(await repository.findCreatedDid(agentContext, 'did:peer:4short')).toBe(created)
    expect(await repository.findAllByDid(agentContext, 'did:peer:4short')).toEqual([created, byAlternative])
  })

  it('returns a record matching both did and alternative did once', async () => {
    const record = didRecord('did:peer:self', DidDocumentRole.Created, { alternativeDids: ['did:peer:self'] })
    records.push(record)

    expect(await repository.findAllByDid(agentContext, 'did:peer:self')).toEqual([record])
    expect(await repository.findCreatedDid(agentContext, 'did:peer:self')).toBe(record)
  })

  it('keeps role and method in the query for created dids', async () => {
    records.push(didRecord('did:peer:created', DidDocumentRole.Created))

    await repository.getCreatedDids(agentContext, { method: 'peer' })
    await repository.getCreatedDids(agentContext, { method: 'peer', did: 'did:peer:created' })

    expect(queries).toEqual([
      { role: DidDocumentRole.Created, method: 'peer' },
      { role: DidDocumentRole.Created, method: 'peer', did: 'did:peer:created' },
      { role: DidDocumentRole.Created, method: 'peer', alternativeDids: ['did:peer:created'] },
    ])
  })
})

describe('patched DidCommConnectionRepository.findByDids', () => {
  let records: DidCommConnectionRecord[]
  let queries: TagQuery[]

  const connection = (tags: Partial<DidCommConnectionRecord>) =>
    new DidCommConnectionRecord({
      state: DidCommDidExchangeState.Completed,
      role: DidCommDidExchangeRole.Responder,
      ...tags,
    })

  const repository = (cache?: Map<string, unknown>) => ({
    agentContext: fakeAgentContext(cache),
    repository: new DidCommConnectionRepository(fakeStorage(records, queries), {} as EventEmitter),
  })

  beforeEach(() => {
    records = []
    queries = []
  })

  it('prefers a match on the current dids and stops querying', async () => {
    const current = connection({ did: 'did:ours', theirDid: 'did:theirs' })
    records.push(current, connection({ did: 'did:ours', previousTheirDids: ['did:theirs'] }))
    const { agentContext, repository: connections } = repository()

    expect(await connections.findByDids(agentContext, { ourDid: 'did:ours', theirDid: 'did:theirs' })).toBe(current)
    expect(queries).toEqual([{ did: 'did:ours', theirDid: 'did:theirs' }])
  })

  it('falls back to previous dids', async () => {
    const rotated = connection({ previousDids: ['did:ours'], theirDid: 'did:theirs' })
    records.push(rotated)
    const { agentContext, repository: connections } = repository()

    expect(await connections.findByDids(agentContext, { ourDid: 'did:ours', theirDid: 'did:theirs' })).toBe(rotated)
    expect(queries).toHaveLength(3)
    expect(await connections.findByDids(agentContext, { ourDid: 'did:other', theirDid: 'did:theirs' })).toBeNull()
  })

  it('keeps using the cache', async () => {
    records.push(connection({ did: 'did:ours', theirDid: 'did:theirs' }))
    const { agentContext, repository: connections } = repository(new Map())

    await connections.findByDids(agentContext, { ourDid: 'did:ours', theirDid: 'did:theirs' })
    await connections.findByDids(agentContext, { ourDid: 'did:ours', theirDid: 'did:theirs' })

    expect(queries).toHaveLength(1)
  })
})

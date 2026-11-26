import {randomUUID} from 'node:crypto'
import {readRecord, writeRecord} from '../shared/atomic-json'

export interface ResultIdentity {identity: string; seq: number; turn: number; step?: number; at: number; snoozedUntil?: number}
export interface FailureIdentity extends ResultIdentity {known: boolean; ended: boolean; category?: 'quota' | 'rate-limit' | 'failure'}
export interface ReadingRecord {sessionId: string; observedThrough: number; readThrough: number; results: ResultIdentity[]; failures: FailureIdentity[]; lastSignificantAt: number}
export type ReadingAction = 'read' | 'known' | 'end' | 'snooze'
export interface UndoReceipt {token: string; expiresAt: number}
interface Change<T> {before: T; after?: T}
interface Undo extends UndoReceipt {sessionId: string; results: Change<ResultIdentity>[]; failures: Change<FailureIdentity>[]}
export class UndoExpired extends Error {}
interface Document {schema: 1; records: ReadingRecord[]}
const int = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512
const position = (v: any) => id(v?.identity) && int(v.seq) && int(v.turn) && (v.step === undefined || int(v.step)) && Number.isFinite(v.at)
  && (v.snoozedUntil === undefined || int(v.snoozedUntil))
const isCategory = (v: unknown) => v === undefined || v === 'quota' || v === 'rate-limit' || v === 'failure'
const validReading = (v: any): v is Document => v?.schema === 1 && Array.isArray(v.records) && v.records.length <= 1500 && v.records.every((r: any) =>
  id(r.sessionId) && int(r.observedThrough) && int(r.readThrough) && Number.isFinite(r.lastSignificantAt)
  && Array.isArray(r.results) && r.results.length <= 4096 && r.results.every(position)
  && Array.isArray(r.failures) && r.failures.length <= 4096 && r.failures.every((f: any) => position(f) && typeof f.known === 'boolean' && typeof f.ended === 'boolean' && isCategory(f.category)))

export const available = (item: ResultIdentity, now = Date.now()) => item.snoozedUntil === undefined || item.snoozedUntil <= now
export const pendingFailure = (item: FailureIdentity, now = Date.now()) => !item.known && !item.ended && available(item, now)

/** DSH 0.2.2-rc.1 stores the original LlmFailure on an error termination. Only structured facts are used. */
export function failureCategory(reason: {kind?: string; error?: {code?: string; status?: number}} | undefined): NonNullable<FailureIdentity['category']> {
  if (reason?.kind !== 'error') return 'failure'
  const {code, status} = reason.error ?? {}
  if (status === 401 || status === 403) return 'failure'
  if (code === 'CHATGPT_USAGE_LIMIT' || code === 'GROK_QUOTA') return 'quota'
  if (code === 'RATE_LIMIT' || status === 429) return 'rate-limit'
  return 'failure'
}

function restore<T extends ResultIdentity>(items: T[], changes: Change<T>[]) {
  const next = new Map(items.map(item => [item.identity, item]))
  for (const {before, after} of changes) {
    const current = next.get(before.identity)
    // A later action (including reading a result) takes precedence over this Undo.
    if (JSON.stringify(current) === JSON.stringify(after)) next.set(before.identity, before)
  }
  return [...next.values()].sort((a, b) => a.seq - b.seq)
}

/** Host-only single writer. Stable native event positions, never completionUnread or generation ids.
 * Acknowledgements consume exact result identities; a later arriving result is never swept up.
 * No prompt, reply, error body or credential is persisted here. */
export class AttentionHistory {
  private document: Document = {schema: 1, records: []}
  private writes: Promise<unknown> = Promise.resolve()
  private replies = new Map<string, {turn: number; step: number}>()
  private undoReceipts = new Map<string, Undo>()
  private undoing = new Set<string>()
  private active?: {ids: ReadonlySet<string>; at: number}
  healthy = true
  private needsReload = false
  constructor(private path: string, private now = () => Date.now()) {}
  async load() {
    try {this.document = await readRecord(this.path, validReading, {schema: 1, records: []}); this.needsReload = false; this.healthy = true}
    catch {this.needsReload = true; this.healthy = false}
    return this
  }
  get(sessionId: string) {return this.document.records.find(r => r.sessionId === sessionId)}
  sessionIds() {return this.document.records.map(r => r.sessionId)}
  /** The unarchived sessions DSH lists now. A record of any other session may be evicted once over the bound. */
  listed(ids: ReadonlySet<string>, at = Date.now()) {this.active = {ids, at}}
  private change<T>(edit: (document: Document) => T, retainOnFailure = false): Promise<T> {
    const write = this.writes.then(async () => {
      if (this.needsReload) {await this.load(); if (this.needsReload) throw new Error('Attention history unreadable')}
      const next = structuredClone(this.document); const result = edit(next)
      // Never turn eviction into an implicit read/acknowledgement of a listed session. Empty, fully handled
      // records go first, then records of sessions archived or deleted since (none newer than the last list,
      // which a new session may be missing from). If all remaining records carry unread/unresolved work of
      // listed sessions, P1 degrades visibly; P0 pending-input sampling/notifications remain independent.
      const empty = (r: ReadingRecord) => !r.results.length && !r.failures.some(f => !f.ended)
      const byAge = (a: ReadingRecord, b: ReadingRecord) => a.lastSignificantAt-b.lastSignificantAt
      const active = this.active
      const removable = [...next.records.filter(empty).sort(byAge),
        ...active ? next.records.filter(r => !empty(r) && !active.ids.has(r.sessionId) && r.lastSignificantAt <= active.at).sort(byAge) : []]
      while ((next.records.length > 1500 || Buffer.byteLength(JSON.stringify(next)) > 4 * 1024 * 1024) && removable.length) {
        const oldest = removable.shift()!; next.records.splice(next.records.indexOf(oldest),1); this.replies.delete(oldest.sessionId)
      }
      if (!validReading(next) || Buffer.byteLength(JSON.stringify(next)) > 4 * 1024 * 1024) throw new Error('Attention history bound')
      try {await writeRecord(this.path, next)} catch (error) {if (retainOnFailure) this.document = next; throw error}
      this.document = next; this.healthy = true; return result
    }).catch(error => {if (!(error instanceof UndoExpired)) this.healthy = false; throw error})
    this.writes = write.catch(() => {}); return write
  }
  observe(sessionId: string, event: {seq: number; type: string; time?: number; data: any}) {
    if (event.type === 'assistant/message' && !event.data.interrupted && event.data.message?.content?.some((b: any) => b.type === 'text' && b.text?.trim() || b.type === 'image')) {
      // Only the newest reply per session matters; keep the table bounded across many sessions.
      this.replies.delete(sessionId); this.replies.set(sessionId, {turn: event.data.turn, step: event.data.step})
      if (this.replies.size > 1024) this.replies.delete(this.replies.keys().next().value!)
      return Promise.resolve()
    }
    if (event.type !== 'turn/end' || !int(event.seq) || !int(event.data.turn)) return Promise.resolve()
    const kind = event.data.reason?.kind
    if (!['completed', 'error', 'interrupted'].includes(kind)) return Promise.resolve()
    const reply = this.replies.get(sessionId)
    const item = {identity: `${sessionId}:turn-end:${event.seq}`, seq: event.seq, turn: event.data.turn,
      ...(kind === 'completed' && reply && reply.turn === event.data.turn ? {step: reply.step} : {}), at: Number.isFinite(event.time) ? event.time! : Date.now()}
    return this.change(doc => {
      let record = doc.records.find(r => r.sessionId === sessionId)
      if (!record) {record = {sessionId, observedThrough: 0, readThrough: 0, results: [], failures: [], lastSignificantAt: item.at}; doc.records.push(record)}
      if (event.seq <= record.observedThrough) return
      record.observedThrough = event.seq; record.lastSignificantAt = item.at
      if (kind === 'completed') {
        record.results.push(item)
        // Success alone does not prove an older problem fixed. Keep it until explicit end attention.
      } else record.failures.push({...item, known: false, ended: false, category: failureCategory(event.data.reason)})
    }, true)
  }
  async acknowledge(sessionId: string, identities: string[], action: ReadingAction, automatic = false): Promise<UndoReceipt | undefined> {
    if (!id(sessionId) || !Array.isArray(identities) || identities.length > 4096 || !identities.every(id) || !['read','known','end','snooze'].includes(action)) throw new Error('Invalid attention acknowledgement')
    const selected = new Set(identities)
    const changes = await this.change(doc => {
      const results: Change<ResultIdentity>[] = [], failures: Change<FailureIdentity>[] = []
      const row = doc.records.find(r => r.sessionId === sessionId)
      if (!row) return {results, failures}
      const now = this.now()
      const snoozedUntil = now + 60 * 60_000
      if (action === 'read') {
        row.results = row.results.filter(result => {
          if (!selected.has(result.identity) || (automatic && !available(result, now))) return true
          row.readThrough = Math.max(row.readThrough, result.seq)
          return false
        })
      }
      if (action === 'snooze') row.results = row.results.map(result => {
        if (!selected.has(result.identity) || !available(result, now)) return result
        const after = {...result, snoozedUntil}
        results.push({before: result, after})
        return after
      })
      if (action !== 'read') row.failures = row.failures.flatMap(failure => {
        if (!selected.has(failure.identity) || failure.ended) return [failure]
        if (action === 'end') {failures.push({before: failure}); return []}
        if (!pendingFailure(failure, now)) return [failure]
        const after = action === 'known' ? {...failure, known: true} : {...failure, snoozedUntil}
        failures.push({before: failure, after})
        return [after]
      })
      // Reading and acknowledgement never modify ordering timestamps.
      return {results, failures}
    })
    const now = this.now()
    this.expireUndo(now)
    if (automatic || action === 'read' || (!changes.results.length && !changes.failures.length)) return
    const receipt = {token: randomUUID(), expiresAt: now + 5000}
    this.undoReceipts.set(receipt.token, {...receipt, sessionId, ...changes})
    return receipt
  }

  async undo(token: string) {
    this.expireUndo(this.now())
    const entry = this.undoReceipts.get(token)
    if (!entry || this.undoing.has(token)) throw new UndoExpired()
    this.undoing.add(token)
    try {
      await this.change(doc => {
        if (this.now() >= entry.expiresAt) throw new UndoExpired()
        const row = doc.records.find(r => r.sessionId === entry.sessionId)
        if (!row) throw new UndoExpired()
        row.results = restore(row.results, entry.results)
        row.failures = restore(row.failures, entry.failures)
      })
      this.undoReceipts.delete(token)
    } finally {this.undoing.delete(token)}
  }

  private expireUndo(now: number) {
    for (const [token, receipt] of this.undoReceipts) if (receipt.expiresAt <= now) this.undoReceipts.delete(token)
  }
}

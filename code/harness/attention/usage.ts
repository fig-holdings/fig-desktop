/**
 * Fig token usage for the last 7 local days, by hour. Reads DSH's public session events
 * (`assistant/message` carries `data.usage`); never parses session files. Totals include cache
 * reads and writes, matching DSH's `totalTokens`.
 */

import {containingWorkspace, workspaceName} from '../shared/workspaces'
import {modelSource, type ModelSource} from '../shared/team-models.ts'

const DAY = 86_400_000
const USAGE_DAYS = 7

interface UsageRecord {
  at: number
  /** The Session the call belongs to; '' when the event carried none. */
  sessionId: string
  cwd: string | undefined
  model: string
  provider: string
  input: number
  cache: number
  output: number
  total: number
  metered: boolean
}

export interface UsageShare { name: string, total: number }
export interface UsageCell {
  total: number
  input: number
  cache: number
  output: number
  /** Model calls that reported no usage. */
  unmetered: number
  /** 0 = empty, 1..4 = rank among the non-empty cells of the window. */
  level: number
  projects: UsageShare[]
  models: UsageShare[]
  /** This hour's tokens by Session, largest first; they add up to `total` (figActivity v2, Fig Cowork §2). */
  sessions: {id: string, total: number, sources?: Partial<Record<ModelSource, number>>}[]
}
export interface UsageView {
  /** Local midnight of each row, oldest first. */
  days: number[]
  /** 7 rows × 24 hours. */
  cells: UsageCell[][]
  peak: number
  total: number
  loading: boolean
  failed: boolean
}
export interface UsageEvent { type: string, seq?: number, time?: number, data?: any }
export interface UsageWorkspace { path: string }

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/** Local midnight six days before `now`: the first row of the window. */
export function windowStart(now: number) {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() - (USAGE_DAYS - 1))
  return day.getTime()
}

/** Largest shares first; the rest collapses into one entry named `''`. */
function top(map: Map<string, number>, limit = 3): UsageShare[] {
  const sorted = [...map].map(([name, total]) => ({name, total})).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  if (sorted.length <= limit) return sorted
  return [...sorted.slice(0, limit), {name: '', total: sorted.slice(limit).reduce((sum, item) => sum + item.total, 0)}]
}

/** Project name: the longest registered Workspace containing the cwd, else the cwd's last segment. */
export function projectName(cwd: string | undefined, workspaces: readonly UsageWorkspace[]) {
  if (!cwd) return ''
  return workspaceName(containingWorkspace(workspaces, cwd)?.path ?? cwd) ?? ''
}

export class UsageLedger {
  readonly records = new Map<string, UsageRecord>()
  loading = false
  failed = false
  private prunedAt = -Infinity

  /** Records one durable event. Returns its time when it is a model `assistant/message`. */
  observe(sessionId: string, cwd: string | undefined, event: UsageEvent, now = Date.now()): number | undefined {
    if (event?.type !== 'assistant/message' || typeof event.time !== 'number') return
    // Drop records that left the window as events arrive, at most once a minute, not only when the panel opens.
    if (now - this.prunedAt >= 60_000) {
      this.prunedAt = now
      const start = windowStart(now)
      for (const [key, record] of this.records) if (record.at < start) this.records.delete(key)
    }
    const message = event.data?.message
    if (message?.source?.kind !== 'model') return event.time
    // Message ids survive fork-inherited prefixes, so a forked call counts once.
    const key = typeof message.id === 'string' ? message.id : sessionId + ':' + event.seq
    if (this.records.has(key)) return event.time
    const usage = event.data?.usage
    const input = count(usage?.inputTokens), output = count(usage?.outputTokens)
    const cache = count(usage?.cacheReadTokens) + count(usage?.cacheWriteTokens)
    this.records.set(key, {
      at: event.time, sessionId: typeof sessionId === 'string' ? sessionId : '', cwd,
      model: typeof message.source.model === 'string' ? message.source.model : '',
      provider: typeof message.source.provider === 'string' ? message.source.provider : '',
      input, cache, output,
      total: count(usage?.totalTokens) || input + output + cache,
      metered: usage !== undefined && usage !== null
    })
    return event.time
  }

  view(workspaces: readonly UsageWorkspace[], now = Date.now(), organizationProviders?: readonly string[]): UsageView {
    const start = windowStart(now)
    const days = Array.from({length: USAGE_DAYS}, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d.getTime() })
    const raw = days.map(() => Array.from({length: 24}, () => ({total: 0, input: 0, cache: 0, output: 0, unmetered: 0,
      projects: new Map<string, number>(), models: new Map<string, number>(), sessions: new Map<string, UsageCell['sessions'][number]>()})))
    for (const [key, record] of this.records) {
      if (record.at < start) { this.records.delete(key); continue }
      const at = new Date(record.at)
      const midnight = new Date(at); midnight.setHours(0, 0, 0, 0)
      const row = days.indexOf(midnight.getTime())
      if (row < 0) continue
      const cell = raw[row][at.getHours()]
      if (!record.metered) { cell.unmetered++; continue }
      cell.total += record.total; cell.input += record.input; cell.cache += record.cache; cell.output += record.output
      const project = projectName(record.cwd, workspaces)
      cell.projects.set(project, (cell.projects.get(project) ?? 0) + record.total)
      cell.models.set(record.model, (cell.models.get(record.model) ?? 0) + record.total)
      const session = cell.sessions.get(record.sessionId) ?? {id: record.sessionId, total: 0}
      session.total += record.total
      const source = organizationProviders && modelSource(record.provider, organizationProviders)
      if (source) {
        const sources = session.sources ??= {}
        sources[source] = (sources[source] ?? 0) + record.total
      }
      cell.sessions.set(record.sessionId, session)
    }
    const filled = raw.flat().map(c => c.total).filter(Boolean).sort((a, b) => a - b)
    // Rank-based steps: the smallest non-empty cell is 1, the peak is 4, ties share a step.
    const level = (total: number) => !total ? 0 : filled.length < 2 ? 4 : 1 + Math.floor(3 * filled.indexOf(total) / (filled.length - 1))
    const cells = raw.map(row => row.map(({projects, models, sessions, ...cell}) => ({...cell, level: level(cell.total), projects: top(projects), models: top(models),
      sessions: [...sessions.values()].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))})))
    return {days, cells, peak: filled.at(-1) ?? 0, total: filled.reduce((a, b) => a + b, 0), loading: this.loading, failed: this.failed}
  }
}

export interface UsageSummary { sessionId: string, updatedAt: number, cwd?: string, origin?: 'subagent', parentSessionId?: string }
export interface UsageEventsPage { records: readonly {type: string, event?: UsageEvent}[], hasMore: boolean, cursor: number }
export interface UsageSource {
  list(request: object, signal: AbortSignal): Promise<{items: readonly UsageSummary[]}>
  events(request: {address: object, maxMessages: number, beforeSeq?: number}, signal: AbortSignal): Promise<UsageEventsPage>
}

/**
 * Reads the window's history once, newest pages first, four Sessions at a time. Live events
 * keep arriving through `observe`; message ids make the overlap harmless.
 */
export async function backfillUsage(source: UsageSource, ledger: UsageLedger, signal: AbortSignal, now = Date.now()) {
  const start = windowStart(now)
  const {items} = await source.list({}, signal)
  const recent = items.filter(item => item.updatedAt >= start)
  const read = async (item: UsageSummary) => {
    // `unknown` mode is DSH's history-read address for a child, validated against its direct parent.
    const address = item.origin === 'subagent' && item.parentSessionId
      ? {kind: 'subagent', parentSessionId: item.parentSessionId, childSessionId: item.sessionId, mode: 'unknown'}
      : {kind: 'session', sessionId: item.sessionId}
    let before: number | undefined
    for (let pages = 0; pages < 100; pages++) {
      const page = await source.events({address, maxMessages: 200, ...(before === undefined ? {} : {beforeSeq: before})}, signal)
      let oldest = Infinity
      for (const record of page.records) if (record.type === 'event' && record.event) {
        if (typeof record.event.time === 'number') oldest = Math.min(oldest, record.event.time)
        ledger.observe(item.sessionId, item.cwd, record.event)
      }
      if (!page.hasMore || oldest < start || (before !== undefined && page.cursor >= before)) return
      before = page.cursor
    }
  }
  let failures = 0
  for (let offset = 0; offset < recent.length; offset += 4) {
    signal.throwIfAborted()
    await Promise.all(recent.slice(offset, offset + 4).map(item => read(item).catch(() => { failures++ })))
  }
  return {sessions: recent.length, failures}
}

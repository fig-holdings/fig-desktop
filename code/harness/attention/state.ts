import { pendingKinds, type AttentionEvent, type AttentionRow, type AttentionSnapshot, type PendingKind } from '../shared/attention-contract.ts'
import { available, pendingFailure, type ReadingRecord, type ResultIdentity } from './history.ts'

export interface Summary { sessionId: string; origin?: string; parentSessionId?: string; running: boolean; agentAvailable: boolean }
interface TrackedEvent extends AttentionEvent {turnSeq?: number; reminderAt?: number}
/** Pure projection. Only a full successful sampling round can replace membership or pending facts. */
export class AttentionState {
  readonly rows = new Map<string, AttentionRow>()
  private episodes = new Map<string, number>()
  private events: TrackedEvent[] = []
  /** Reminder suffixes already raised, per session; kept while a session is briefly out of the rows. */
  private reminded = new Map<string, Set<string>>()
  private roots = new Map<string, string>()
  private seenEvents = new Map<string, number>()
  private cursor = 0
  private excluded = new Set<string>()
  private initialized = false
  private unassigned: {sessionId: string; event: {seq: number; type: string; data: any}}[] = []
  synced = false
  historyOf?: (sessionId: string) => ReadingRecord | undefined
  constructor(readonly generation: string, private readonly startedAt = Date.now()) {}
  /** `listed`, when given, holds every session DSH lists; per-session tables forget sessions no longer in it. */
  sample(items: Summary[], workspaces: {id: string; sessionIds: readonly string[]}[], archived: readonly string[], states: Map<string, {pendingInput: readonly string[]; running: boolean; cursor?: number}>, listed?: ReadonlySet<string>) {
    this.excluded = new Set(archived)
    const eligible = new Map(items.filter(item => !this.excluded.has(item.sessionId)).map(item => [item.sessionId, item]))
    const workspaceOf = new Map<string, string>()
    for (const workspace of workspaces) for (const id of workspace.sessionIds) if (!workspaceOf.has(id)) workspaceOf.set(id, workspace.id)
    const roots = new Map<string, string>()
    for (const item of eligible.values()) {
      let root = item; const seen = new Set<string>()
      while (root.origin === 'subagent' && root.parentSessionId) {
        if (seen.has(root.sessionId)) break
        seen.add(root.sessionId)
        const parent = eligible.get(root.parentSessionId)
        if (!parent) break
        root = parent
      }
      if (root.origin !== 'subagent') roots.set(item.sessionId, root.sessionId)
    }
    const next = new Map<string, AttentionRow>()
    for (const [id, root] of roots) {
      const previous = this.rows.get(root)
      const row = next.get(root) ?? { sessionId: root, workspaceId: workspaceOf.get(root),
        running: false, pendingKinds: [], lastSignificantAt: previous?.lastSignificantAt ?? this.historyOf?.(root)?.lastSignificantAt ?? Date.now(),
        lastEventSeq: previous?.lastEventSeq, turnId: previous?.turnId, endReason: previous?.endReason, pendingSince: {...previous?.pendingSince} }
      const state = states.get(id)
      // A terminal event may arrive while the passive read is in flight; its newer fact wins.
      row.running ||= id === root && previous?.lastEventSeq !== undefined && previous.lastEventSeq > (state?.cursor ?? -1)
        ? previous.running : state?.running ?? eligible.get(id)!.running
      for (const kind of pendingKinds) if (state?.pendingInput.includes(kind) && !row.pendingKinds.includes(kind)) row.pendingKinds.push(kind)
      next.set(root, row)
    }
    for (const [id, row] of next) {
      row.pendingKinds.sort((a, b) => pendingKinds.indexOf(a) - pendingKinds.indexOf(b))
      const prior = this.rows.get(id)
      for (const kind of pendingKinds) if (!row.pendingKinds.includes(kind)) delete row.pendingSince?.[kind]
      for (const kind of row.pendingKinds) if (!prior?.pendingKinds.includes(kind)) {
        row.pendingSince ??= {}; row.pendingSince[kind] = Date.now()
        const key = id + ':' + kind
        const episode = (this.episodes.get(key) ?? 0) + 1
        this.episodes.set(key, episode)
        if (this.initialized) this.push(id, kind, `pending:${kind}:${episode}`)
      }
      if (prior && (prior.running !== row.running || prior.pendingKinds.join() !== row.pendingKinds.join())) row.lastSignificantAt = Date.now()
    }
    if (listed) {
      for (const key of this.episodes.keys()) if (!listed.has(key.slice(0, key.lastIndexOf(':')))) this.episodes.delete(key)
      for (const id of this.seenEvents.keys()) if (!listed.has(id)) this.seenEvents.delete(id)
      for (const id of this.reminded.keys()) if (!listed.has(id)) this.reminded.delete(id)
    }
    this.rows.clear(); for (const [id, row] of next) this.rows.set(id, row)
    this.roots = roots; this.initialized = true; this.synced = true
    const pending = this.unassigned; this.unassigned = []
    for (const item of pending) if (this.roots.has(item.sessionId)) this.event(item.sessionId, item.event)
  }
  event(sessionId: string, event: { seq: number; type: string; data: any }) {
    if (this.excluded.has(sessionId) || !this.initialized || !Number.isSafeInteger(event.seq) || event.seq <= (this.seenEvents.get(sessionId) ?? -1)) return
    if (!this.roots.has(sessionId)) {
      if (['turn/start', 'turn/end'].includes(event.type)) this.unassigned = [...this.unassigned, {sessionId, event}].slice(-256)
      return
    }
    this.seenEvents.set(sessionId, event.seq)
    // Root turn terminal events alone prove a result/failure; child errors never impersonate a root end.
    if (this.roots.get(sessionId) !== sessionId) return
    const row = this.rows.get(sessionId)
    if (!row || !['turn/start', 'turn/end'].includes(event.type)) return
    row.lastEventSeq = event.seq; row.lastSignificantAt = Date.now()
    row.turnId = String(event.data.turn)
    if (event.type === 'turn/start') { row.running = true; return }
    row.running = false; row.endReason = event.data.reason?.kind
    if (row.endReason === 'completed') this.push(sessionId, 'result', `turn:${event.seq}`, event.seq)
    if (row.endReason === 'error') this.push(sessionId, 'failure', `turn:${event.seq}`, event.seq)
  }

  /** The normal startup baseline stays quiet. An active snooze that expires during this Host run gets one new event. */
  remind(now = Date.now()) {
    const due = new Map<string, Set<string>>()
    const see = (sessionId: string, kind: 'result' | 'failure', item: ResultIdentity) => {
      const at = item.snoozedUntil
      if (at === undefined || at <= this.startedAt || at > now) return
      const suffix = `reminder:${item.seq}:${at}`
      const keys = due.get(sessionId) ?? new Set<string>()
      due.set(sessionId, keys.add(suffix))
      if (!this.reminded.get(sessionId)?.has(suffix)) this.push(sessionId, kind, suffix, item.seq, at)
    }
    for (const sessionId of this.rows.keys()) {
      const record = this.historyOf?.(sessionId)
      for (const result of record?.results ?? []) see(sessionId, 'result', result)
      for (const failure of record?.failures ?? []) if (pendingFailure(failure, now)) see(sessionId, 'failure', failure)
    }
    // A session missing from this round's rows keeps what it was reminded of, or it would be reminded again when it
    // reappears; sample() forgets it once DSH no longer lists the session.
    for (const sessionId of this.rows.keys()) if (!due.has(sessionId)) this.reminded.delete(sessionId)
    for (const [sessionId, keys] of due) this.reminded.set(sessionId, keys)
  }

  private push(sessionId: string, kind: AttentionEvent['kind'], suffix: string, turnSeq?: number, reminderAt?: number) {
    this.events.push({ identity: `${this.generation}:${sessionId}:${suffix}`, sessionId, kind, seq: ++this.cursor, turnSeq, reminderAt })
    this.events = this.events.slice(-256)
  }

  private canAlert(event: TrackedEvent, now: number) {
    if (event.turnSeq === undefined) return true
    const record = this.historyOf?.(event.sessionId)
    if (!record || record.observedThrough < event.turnSeq) return event.reminderAt === undefined
    const item = event.kind === 'failure'
      ? record.failures.find(f => f.seq === event.turnSeq && pendingFailure(f, now))
      : record.results.find(r => r.seq === event.turnSeq && available(r, now))
    return item !== undefined && item.snoozedUntil === event.reminderAt
  }

  read(cursor: number | undefined, preferences: AttentionSnapshot['preferences'], now = Date.now()): AttentionSnapshot {
    const baseline = cursor === undefined
    const gap = !baseline && (cursor > this.cursor || cursor < (this.events[0]?.seq ?? this.cursor + 1) - 1)
    return { schema: 1, generation: this.generation, cursor: this.cursor, baseline, gap, synced: this.synced,
      rows: [...this.rows.values()].map(row => ({...row, pendingKinds: [...row.pendingKinds], unknownFailure: this.historyOf?.(row.sessionId)?.failures.some(f => pendingFailure(f, now)) ?? false})),
      events: baseline || gap ? [] : this.events.filter(event => event.seq > cursor! && this.rows.has(event.sessionId) && this.canAlert(event, now))
        .map(({identity, sessionId, kind, seq}) => ({identity, sessionId, kind, seq})), preferences }
  }
}

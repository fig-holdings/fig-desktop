import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AttentionState } from './state.ts'
import { AttentionHistory, UndoExpired, available } from './history.ts'
import { UsageLedger, backfillUsage } from './usage.ts'
import { readRecord, writeRecord } from '../shared/atomic-json.ts'
import { dshHome } from '../shared/dsh-plugin.js'
import { pageRoute, registerPageRoute, RouteError } from '../shared/http.js'
import { workspaceName } from '../shared/workspaces.ts'

export const name = 'fig-attention'
export const inject = ['sessionController', 'workspaceRegistry']
/** Fixed DSH list is unpaged. Cold history must not exhaust the live-input sampling bound. */
function selectAttentionItems(items, retainedIds) {
  const all = new Map(items.map(item => [item.sessionId, item]))
  const retained = new Set(retainedIds)
  const selected = new Map(items.filter(item => item.agentAvailable || retained.has(item.sessionId)).map(item => [item.sessionId, item]))
  for (const item of items.slice(0, 256)) selected.set(item.sessionId, item)
  for (const item of [...selected.values()]) {
    let parent = item; const seen = new Set()
    while (parent.origin === 'subagent' && parent.parentSessionId && !seen.has(parent.sessionId)) {
      seen.add(parent.sessionId); parent = all.get(parent.parentSessionId)
      if (!parent) break
      selected.set(parent.sessionId, parent)
    }
  }
  return [...selected.values()]
}
// Besides its page, the package offers its state as the `figAttention` service. A desktop shell that alerts
// (Fig's shell-bridge, which offers `shellCapabilities.alerts`) reads it for notifications, the Dock badge and
// keeping the Mac awake; without one, the 任务提醒 settings stay hidden.
export async function apply(ctx) {
  const state = new AttentionState(randomUUID())
  const history = await new AttentionHistory(join(dshHome(), 'fig', 'attention', 'reading-state.json')).load()
  state.historyOf = id => history.get(id)
  const preferences = await preferenceStore(ctx, join(dshHome(), 'fig', 'attention', 'preferences.json'))
  const usage = usageHistory(ctx)
  const sampler = sessionSampler(ctx, state, history)
  registerPageRoute(ctx, '/fig-attention', 'attention page', attentionRoute(ctx, {state, history, preferences, usage, sampler}))
  ctx.provide('figAttention', { read: cursor => state.read(cursor, preferences.get()), idle: () => idle(ctx) })
  ctx.on('session/event', (session, event) => {
    state.event(session.id, event)
    usage.ledger.observe(session.id, session.header.cwd, event)
    if (session.header.origin !== 'subagent') void history.observe(session.id, event).catch(() => {})
  })
  ctx.effect(() => sampler.start())
}

/** The alert preferences, read once and written one at a time. */
async function preferenceStore(ctx, path) {
  /** @type {(value: any) => value is import('../shared/attention-contract.ts').AttentionSnapshot['preferences']} */
  const validPreferences = value => value?.schema === 1 && typeof value.notifications === 'boolean' && typeof value.dock === 'boolean'
  /** @type {import('../shared/attention-contract.ts').AttentionSnapshot['preferences']} */
  const defaults = {schema: 1, notifications: true, dock: true}
  // A preferences file that can be neither read nor set aside must not stop the plugin; defaults apply.
  let preferences = await readRecord(path, validPreferences, defaults).catch(error => {
    ctx.logger?.warn(`Fig attention preferences unreadable, using defaults: ${error?.code ?? 'error'}`)
    return defaults
  })
  let writes = Promise.resolve()
  return {
    get: () => preferences,
    set(payload) {
      const write = writes.then(async () => { const next = {...preferences, ...payload}; await writeRecord(path, next); preferences = next; return preferences })
      writes = write.then(() => {}, () => {})
      return write
    }
  }
}

/** The usage heat map's ledger. History is read on first demand, not at startup; a failed read may retry after 30 seconds. */
function usageHistory(ctx) {
  const ledger = new UsageLedger()
  let usageLoad, usageRetryAt = 0
  const load = () => {
    if (usageLoad || Date.now() < usageRetryAt) return
    ledger.loading = true
    usageLoad = backfillUsage(ctx.sessionController, ledger, AbortSignal.timeout(120_000))
      .then(({failures}) => { ledger.failed = failures > 0 }, () => { ledger.failed = true })
      .finally(() => { ledger.loading = false; if (ledger.failed) { usageLoad = undefined; usageRetryAt = Date.now() + 30_000 } })
  }
  return { ledger, view: () => {
    load()
    return ledger.view(ctx.workspaceRegistry.list(), Date.now(), ctx.get('shellCapabilities')?.teamModels?.organizationProviders)
  } }
}

/** POST /fig-attention/<endpoint> for the package's page. */
function attentionRoute(ctx, {state, history, preferences, usage, sampler}) {
  return pageRoute({ prefix: '/fig-attention', bodyLimit: 3 * 1024 * 1024, failure: () => ({code: 'ATTENTION_UNAVAILABLE'}), endpoints: {
    info: () => ({...state.read(undefined, preferences.get()), alerts: ctx.get('shellCapabilities')?.alerts === true}),
    dynamics: () => {
      const now = Date.now()
      return {generation: state.generation, synced: state.synced, readingHealthy: history.healthy,
      workspaces: sampler.workspaces().map(w => ({id: w.id, name: workspaceName(w.path) ?? w.id})),
      rows: state.read(undefined, preferences.get()).rows.map(row => {
        const record = history.get(row.sessionId)
        return {...row, title: sampler.summaries.get(row.sessionId)?.projections?.values?.title ?? row.sessionId,
          readThrough: record?.readThrough ?? 0, results: record?.results.filter(r => available(r, now)) ?? [],
          failures: record?.failures.filter(f => !f.ended && available(f, now)) ?? [],
          knownFailureIds: record?.failures.filter(f => f.known).map(f => f.identity) ?? [],
          lastSignificantAt: Math.max(row.lastSignificantAt, record?.lastSignificantAt ?? 0)}
      })}
    },
    usage: () => usage.view(),
    acknowledge: async payload => {
      if (!payload || !['sessionId','identities','action'].every(key => Object.hasOwn(payload, key))
        || Object.keys(payload).some(key => !['sessionId','identities','action','automatic'].includes(key))
        || !state.rows.has(payload.sessionId) || (payload.automatic !== undefined
          && !(payload.automatic === true && ['known','read'].includes(payload.action)))) throw new RouteError(400, 'BAD_REQUEST')
      try {return {undo: await history.acknowledge(payload.sessionId, payload.identities, payload.action, payload.automatic)}}
      catch {throw new RouteError(503, 'ATTENTION_STORAGE')}
    },
    undo: async payload => {
      if (!payload || typeof payload.token !== 'string' || payload.token.length !== 36 || Object.keys(payload).length !== 1) throw new RouteError(400, 'BAD_REQUEST')
      try {await history.undo(payload.token); return true}
      catch (error) {
        if (error instanceof UndoExpired) throw new RouteError(409, 'ATTENTION_UNDO_EXPIRED')
        throw new RouteError(503, 'ATTENTION_STORAGE')
      }
    },
    preferences: payload => {
      if (Object.keys(payload).some(key => !['notifications', 'dock'].includes(key)) || Object.values(payload).some(value => typeof value !== 'boolean')) throw new RouteError(400, 'BAD_REQUEST')
      return preferences.set(payload)
    }
  }})
}

/** Whether no Session or background job runs; main asks before a native directory change. */
async function idle(ctx) {
  const controller = ctx.get('sessionController'), jobs = ctx.get('jobs')
  if (!controller || !jobs) return false
  const {items} = await controller.list({}, AbortSignal.timeout(2500))
  const busy = job => job.status === 'running' || job.status === 'stopping'
  return !items.some(item => item.running || jobs.list(item.sessionId).some(busy)) && !jobs.list().some(busy)
}

/** Reads DSH's sessions every second into `state`; a round that fails or overruns marks the state unsynced. */
function sessionSampler(ctx, state, history) {
  const summaries = new Map()
  let workspaces = [], disposed = false, sampling = false
  const sample = async () => {
    if (disposed || sampling) return
    sampling = true
    const signal = AbortSignal.timeout(900)
    try {
      const listed = await ctx.sessionController.list({}, signal)
      const items = selectAttentionItems(listed.items, history.sessionIds())
      const active = items.filter(item => item.agentAvailable)
      if (active.length > 256 || items.length > 4096) throw new Error('sampling bound')
      const states = new Map()
      // Eight passive reads at a time, one shared deadline, no resolve/retain/create.
      for (let offset = 0; offset < active.length; offset += 8) await Promise.all(active.slice(offset, offset + 8).map(async item => states.set(item.sessionId, await ctx.sessionController.state({sessionId: item.sessionId}, signal))))
      signal.throwIfAborted()
      if (!disposed) {
        workspaces = ctx.workspaceRegistry.list()
        summaries.clear(); for (const item of items) summaries.set(item.sessionId, item)
        const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
        const listedIds = new Set(listed.items.map(item => item.sessionId))
        state.sample(items, workspaces, ctx.workspaceRegistry.archivedSessionIds, states, listedIds)
        history.listed(new Set([...listedIds].filter(id => !archived.has(id))))
        state.remind()
      }
    } catch { state.synced = false } finally { sampling = false }
  }
  return {
    summaries,
    workspaces: () => workspaces,
    start() { const timer = setInterval(() => { void sample() }, 1000); void sample(); return () => { disposed = true; clearInterval(timer) } }
  }
}

import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { join } from 'node:path'
import { readRecord, writeRecord } from '../../harness/shared/atomic-json'
import type { DesktopAttentionSnapshot, AttentionEvent } from '../../harness/shared/attention-contract'
import { attentionContextGlobal, attentionNavigateGlobal } from '../../harness/shared/page-contract'
import { tr } from './language'

interface Connection { origin: string; generation: string; capability: string }
interface Target { sessionId: string; eventIdentity: string; navigationId: string }
interface Dependencies {
  connection: () => Connection | undefined;
  foreground: () => boolean;
  execute: (script: string, origin: string) => Promise<any>;
  badge: (text: string) => void;
  show: (event: AttentionEvent, click: () => void) => void;
  activate: () => void;
  syncStatus?: (status: string) => void;
  /** Whether any Session is running; called only on a change. Kept through a disconnect like the badge, cleared on stop. */
  keepAwake?: (running: boolean) => void;
}
/** Notification identities already scheduled, under the DSH home. */
const ledgerPath = (home: string) => join(home, 'fig/attention/notification-ledger.json')

/** The sole main-process writer of scheduled notification identities. It does not promise OS delivery. */
export class DesktopAttention {
  private scheduled: string[] = []
  private cursor?: number
  private generation?: string
  private polling = false
  private timer?: ReturnType<typeof setInterval>
  private target?: Target
  private attempts = 0
  private navigating = false
  private epoch = 0
  private currentStatus: 'syncing' | 'ready' | 'disconnected' | 'stopped' = 'syncing'
  get status() { return this.currentStatus }
  // The Dock menu and badge are rebuilt only on a change, not on every one-second poll.
  private set status(value: typeof this.currentStatus) { this.currentStatus = value; if (value !== this.syncedStatus) { this.syncedStatus = value; this.deps.syncStatus?.(value) } }
  private syncedStatus?: string
  private badgeText?: string
  private badge(text: string) { if (text === this.badgeText) return; this.badgeText = text; this.deps.badge(text) }
  private awake = false
  private keepAwake(running: boolean) { if (running === this.awake) return; this.awake = running; this.deps.keepAwake?.(running) }
  constructor(private home: string, private deps: Dependencies) {}
  private async execute(script: string, origin: string) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([this.deps.execute(script, origin), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Workbench timeout')), 1200) })]) }
    finally { clearTimeout(timer) }
  }
  async start() {
    this.status = 'syncing'; this.cursor = undefined; this.generation = undefined
    const ledger = await readRecord(ledgerPath(this.home), (value): value is {schema: 1; scheduled: string[]} => value?.schema === 1 && Array.isArray(value.scheduled) && value.scheduled.length <= 2048 && value.scheduled.every((id: unknown) => typeof id === 'string' && id.length < 1024), { schema: 1, scheduled: [] })
    this.scheduled = ledger.scheduled
    this.timer = setInterval(() => { void this.poll() }, 1000)
    await this.poll()
  }
  /** Called only after service-group exit is confirmed (or orderly app quit). */
  stop() { this.epoch++; clearInterval(this.timer); this.timer = undefined; this.badge(''); this.keepAwake(false); this.status = 'stopped'; this.target = undefined }
  /** Wait for a ledger write already in flight before copying its data directory. */
  async settle(): Promise<void> {
    this.stop()
    for (const end = Date.now() + 5000; this.polling;) {
      if (Date.now() >= end) throw new Error(tr('任务提醒仍在写入，请稍后重试。', 'Task reminders are still being written. Try again shortly.'))
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  async poll() {
    if (this.polling || this.status === 'stopped') return
    const connection = this.deps.connection()
    if (!connection) { this.status = 'disconnected'; return }
    this.polling = true
    const epoch = this.epoch
    // A stop, or a DSH started again with a new generation, makes this poll's results stale.
    const stale = () => epoch !== this.epoch || this.deps.connection()?.generation !== connection.generation
    try {
      const changed = connection.generation !== this.generation
      const snapshot = await readAttention(connection, changed ? undefined : this.cursor)
      if (stale()) return
      this.generation = connection.generation
      if (!snapshot.synced) { this.status = 'disconnected'; return }
      this.status = 'ready'
      this.badge(snapshot.preferences.dock ? String(snapshot.rows.filter(row => row.pendingKinds.length || row.unknownFailure).length || '') : '')
      this.keepAwake(snapshot.running)
      let current: string | undefined
      if (this.deps.foreground()) {
        // JSON identities only. A conservative visibility adapter returns undefined for overlays/settings.
        const context = await this.execute(`window.${attentionContextGlobal}?.()`, connection.origin).catch(() => undefined)
        if (context?.visible === true && typeof context.sessionId === 'string') current = context.sessionId
      }
      for (const event of snapshot.events) {
        if (stale()) return
        if (this.scheduled.includes(event.identity)) continue
        const next = [...this.scheduled, event.identity].slice(-2048)
        await writeRecord(ledgerPath(this.home), {schema: 1, scheduled: next})
        if (stale()) return
        this.scheduled = next // schedule before OS show; crash here may omit one notification, never approve a task
        if (snapshot.preferences.notifications && current !== event.sessionId) this.deps.show(event, () => {
          this.target = { sessionId: event.sessionId, eventIdentity: event.identity, navigationId: randomUUID() }
          this.attempts = 0; this.deps.activate(); void this.navigate()
        })
      }
      this.cursor = snapshot.cursor
      await this.navigate()
    } catch { if (epoch === this.epoch) this.status = 'disconnected' } finally { this.polling = false }
  }
  async navigate() {
    if (!this.target || this.navigating || this.attempts >= 10) return
    const connection = this.deps.connection()
    if (!connection) return
    const target = this.target
    this.navigating = true; this.attempts++
    try {
      const ack = await this.execute(`window.${attentionNavigateGlobal}?.(${JSON.stringify(target)})`, connection.origin)
      if (this.target?.navigationId === target.navigationId && ack?.navigationId === target.navigationId && ack?.accepted === true) this.target = undefined
    } catch { /* Workbench not ready. Keep the latest target for bounded retries. */ }
    finally { this.navigating = false }
  }
}

/** Fixed loopback endpoint on the Host's desktop bridge (harness/shell-bridge/bridge.ts): no redirects,
 * the capability header, bounded JSON, a timeout and the generation this Host was started with. */
function readBridge(connection: Connection, path: string, payload: object, timeout: number): Promise<unknown> {
  const url = new URL(path, connection.origin)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) return Promise.reject(new Error('Invalid origin'))
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({generation: connection.generation, ...payload})
    const req = request(url, {method: 'POST', headers: {'x-fig-attention': connection.capability, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}}, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('Bridge unavailable')); return }
      let size = 0; const chunks: Buffer[] = []
      res.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) req.destroy(new Error('Too large')); else chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
      })
    })
    req.setTimeout(timeout, () => req.destroy(new Error('Bridge timeout')))
    req.on('error', reject); req.end(body)
  })
}

/** The attention snapshot after `cursor`, validated in shape and against the generation. */
export async function readAttention(connection: Connection, cursor?: number): Promise<DesktopAttentionSnapshot> {
  const value = await readBridge(connection, '/fig-desktop/attention/read', cursor === undefined ? {} : {cursor}, 1500)
  if (!validSnapshot(value, connection.generation, cursor)) throw new Error('Invalid snapshot')
  return value
}

/** Whether no Session or background job runs on the Host; checked before a native directory change. */
export async function readIdle(connection: Connection | undefined): Promise<boolean> {
  if (!connection) throw new Error('Host unavailable')
  const value: any = await readBridge(connection, '/fig-desktop/activity', {}, 4000)
  if (typeof value?.idle !== 'boolean' || Object.keys(value).length !== 1) throw new Error('Invalid activity')
  return value.idle
}
function validSnapshot(value: any, generation: string, cursor?: number): value is DesktopAttentionSnapshot {
  const id = (v: any) => typeof v === 'string' && v.length > 0 && v.length <= 512
  const kinds = ['approval', 'question', 'other']
  return value?.schema === 1 && value.generation === generation && typeof value.running === 'boolean' && Number.isSafeInteger(value.cursor) && value.cursor >= (cursor ?? 0) && typeof value.synced === 'boolean' && typeof value.gap === 'boolean' && value.baseline === (cursor === undefined)
    && Array.isArray(value.rows) && value.rows.length <= 2048 && value.rows.every((row: any) => id(row.sessionId) && typeof row.running === 'boolean' && (row.unknownFailure === undefined || typeof row.unknownFailure === 'boolean') && Array.isArray(row.pendingKinds) && row.pendingKinds.length <= 3 && row.pendingKinds.every((kind: string) => kinds.includes(kind)))
    && Array.isArray(value.events) && value.events.length <= 256 && value.events.every((event: any) => id(event.sessionId) && id(event.identity) && ['failure', 'result', ...kinds].includes(event.kind) && Number.isSafeInteger(event.seq) && event.seq > (cursor ?? -1) && event.seq <= value.cursor && value.rows.some((row: any) => row.sessionId === event.sessionId))
    && (!value.baseline && !value.gap || value.events.length === 0)
    && value.preferences?.schema === 1 && typeof value.preferences.notifications === 'boolean' && typeof value.preferences.dock === 'boolean'
}

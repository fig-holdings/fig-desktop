const reloadDelay = 500
const crashWindow = 60_000
const maxWait = 120_000
/** Automatic reloads per DSH launch; a manual retry starts a new launch and a new count. */
const maxReloads = 4

export type RecoveryPhase = 'normal' | 'recovering' | 'rate-limited' | 'failed'
export type RecoveryFailure = 'load' | 'timeout' | 'limit'

interface RecoveryHost {
  active(): boolean
  load(): Promise<void>
  changed(): void
  recovered(): void
  failed(reason: RecoveryFailure): void
}

/** One instance per workbench view and DSH launch. The host cancels it before relinquishing either. */
export class WorkbenchRecovery {
  private crashes: number[] = []
  private reloads = 0
  private timer?: ReturnType<typeof setTimeout>
  private cancelled = false
  private loading = false
  private current: RecoveryPhase = 'normal'

  constructor(private readonly host: RecoveryHost, private readonly now = () => performance.now()) {}

  get phase(): RecoveryPhase { return this.current }

  crashed(): void {
    if (!this.active()) return
    if (this.loading) { this.fail('load'); return }
    if (this.current !== 'normal') return
    if (this.reloads >= maxReloads) { this.fail('limit'); return }
    this.reloads++

    const now = this.now()
    this.crashes = this.crashes.filter(at => now - at < crashWindow)
    this.crashes.push(now)
    const limited = this.crashes.length >= 4
    const wait = limited ? Math.max(reloadDelay, this.crashes.at(-4)! + crashWindow - now) : reloadDelay
    const deadline = now + maxWait
    this.timer = setTimeout(() => { void this.reload(deadline) }, wait)
    this.change(limited ? 'rate-limited' : 'recovering')
  }

  cancel(): void {
    this.cancelled = true
    clearTimeout(this.timer)
  }

  private active(): boolean {
    return !this.cancelled && this.current !== 'failed' && this.host.active()
  }

  private change(phase: RecoveryPhase): void {
    this.current = phase
    this.host.changed()
  }

  private async reload(deadline: number): Promise<void> {
    if (!this.active()) return
    const remaining = deadline - this.now()
    if (remaining <= 0) { this.fail('timeout'); return }
    this.loading = true
    this.timer = setTimeout(() => this.fail('timeout'), remaining)
    if (this.current === 'rate-limited') this.change('recovering')
    try {
      await this.host.load()
    } catch {
      this.fail('load')
      return
    }
    if (!this.active()) return
    if (this.now() >= deadline) { this.fail('timeout'); return }
    clearTimeout(this.timer)
    this.loading = false
    this.current = 'normal'
    this.host.recovered()
  }

  private fail(reason: RecoveryFailure): void {
    if (!this.active()) return
    clearTimeout(this.timer)
    this.current = 'failed'
    this.host.failed(reason)
  }
}

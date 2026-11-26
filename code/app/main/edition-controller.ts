import type { MessageBoxOptions } from 'electron'
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonFile, writeRecord } from '../../harness/shared/atomic-json.ts'
import { errorText } from '../../harness/shared/log'
import { validId } from '../../harness/shared/team-models.ts'
import type { EditionState } from '../shared/protocol'
import { coworkLogin, type CoworkConnection } from './cowork-login'
import { CoworkAuthorizationExpired, type CoworkIdentity, type CoworkSession, type TeamRequestProof } from './cowork-session'
import { tr } from './language'
import { descriptorPath } from './profile'

/** What the edition switch needs from the app: the DSH service, the window and the user. */
export interface EditionHost {
  userData: string
  personalHome(): string
  /** The Edition of the running DSH Profile. */
  profileEdition(): EditionState['edition'] | undefined
  quitting(): boolean
  /** A retry or the first-run folder choice is under way; edition actions wait for it. */
  blocked(): boolean
  attached(): boolean
  /** Asks before stopping sessions that may be running; true to go ahead. */
  confirmChange(): Promise<boolean>
  ask(options: MessageBoxOptions): Promise<number>
  errorBox(title: string, text: string): void
  openExternal(url: string): Promise<void>
  trash(path: string): Promise<void>
  /** Stops DSH and the workbench for a switch. */
  stop(): Promise<void>
  /** Starts DSH from `home`. */
  launch(home: string): Promise<void>
  changed(): void
  /** Tells the workbench page that the signed-in account changed. */
  pageChanged(): void
}

/**
 * Personal and team (Fig Cowork) editions. Every Cowork lookup — at startup, from an action, and the periodic check —
 * runs as the one edition task, so two lookups never race on the stored grant and a switch never meets a launch.
 */
export class EditionController {
  screen: EditionState['screen']
  selected = false
  private identity: CoworkIdentity | undefined
  private activeProfile: string | undefined
  private task: Promise<void> | undefined
  private checking = false
  private loginAbort: AbortController | undefined

  constructor(private readonly host: EditionHost, private readonly session?: CoworkSession, private readonly config?: CoworkConnection) {}

  /** An edition task is running. */
  get busy(): boolean { return Boolean(this.task) }

  async authorizeTeamRequest(profile: string, request: TeamRequestProof) {
    const active = () => this.selected && this.activeProfile === profile && !this.screen && !this.host.quitting()
    if (!this.session || !active()) throw new CoworkAuthorizationExpired()
    const authorization = await this.session.authorizeTeamRequest(profile, request)
    if (!active()) throw new CoworkAuthorizationExpired()
    return authorization
  }

  state(): EditionState {
    return {
      edition: this.selected ? 'team' : this.host.profileEdition() ?? 'personal',
      available: Boolean(this.session), screen: this.screen,
      name: this.identity?.name, organization: this.identity?.organization?.name,
      adminConsoleUrl: this.identity?.organization?.adminConsoleUrl, allowPersonal: this.identity?.models.allowPersonal
    }
  }

  private get preference() { return join(this.host.userData, 'cowork', 'edition.json') }

  /** Starts the saved edition; false when it is personal and the caller starts DSH. */
  async start(): Promise<boolean> {
    let team = false
    await this.run(async () => {
      team = this.selected = Boolean(this.session && (await readJsonFile(this.preference))?.edition === 'team')
      if (team) await this.useSession(false)
    })
    return team
  }

  /** Cancels a browser sign-in in progress (quitting). */
  abortLogin(): void { this.loginAbort?.abort() }

  private run(work: () => Promise<void>, checking = false): Promise<void> {
    this.checking = checking
    const task = work().finally(() => {
      if (this.task !== task) return
      this.task = undefined
      this.checking = false
    })
    this.task = task
    return task
  }

  private async useSession(login: boolean): Promise<void> {
    const client = this.session, config = this.config
    if (!client || !config) return
    this.screen = 'signing-in'
    this.host.changed()
    const abort = new AbortController()
    this.loginAbort = abort
    try {
      const { identity, profile } = await client.current().catch(async error => {
        if (!login || !(error instanceof CoworkAuthorizationExpired)) throw error
        const grant = await coworkLogin(config, url => this.host.openExternal(url), AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]))
        return client.current(grant)
      })
      if (this.host.quitting() || abort.signal.aborted) return
      this.identity = identity
      if (!profile) {
        await writeRecord(this.preference, { edition: 'team' })
        this.screen = 'waiting'
        return
      }
      if (!validId(profile) || profile === '.' || profile === '..') throw new Error('COWORK_PROFILE')
      const home = join(this.host.userData, 'cowork', 'profiles', profile)
      const path = descriptorPath(home)
      const stored = await readFile(path, 'utf8').then(JSON.parse).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        if (!(error instanceof SyntaxError)) throw error
        // An unreadable descriptor is kept aside and written again from the account.
        await rename(path, path + '.unreadable')
        return undefined
      })
      await writeRecord(path, { ...stored, schema: 1, id: profile, edition: 'team', coworkOrigin: config.origin, teamModels: identity.models, teamPlugins: identity.plugins })
      await writeRecord(this.preference, { edition: 'team' })
      this.activeProfile = profile
      this.screen = undefined
      await this.host.launch(home)
    } catch (error) {
      this.screen = error instanceof CoworkAuthorizationExpired || /^COWORK_AUTH|^COWORK_CANCELLED/.test(errorText(error)) ? 'expired' : 'unavailable'
    } finally {
      if (this.loginAbort === abort) this.loginAbort = undefined
      this.host.changed()
    }
  }

  action(action: unknown): Promise<void> {
    if (this.host.quitting() || this.host.blocked()) return Promise.resolve()
    if (this.task) {
      if (this.checking) return this.task.then(() => this.action(action))
      if (action !== 'personal' || !this.loginAbort) return this.task
      this.loginAbort.abort()
      return this.task.then(() => this.action('personal'))
    }
    if (typeof action !== 'string' || !['team', 'personal', 'check', 'signOut', 'removeDevice'].includes(action)) return Promise.resolve()
    return this.run(async () => {
      if (action === 'team' && (!this.session || (this.activeProfile && !this.screen))) return
      if (action === 'check' && (!this.selected || !this.screen)) return
      if ((action === 'personal' || action === 'signOut' || action === 'removeDevice') && !this.selected) return
      const removing = action === 'removeDevice' ? this.activeProfile : undefined
      if (action === 'removeDevice' && (!removing || !this.session || this.screen)) return
      if (!this.screen && !await this.host.confirmChange()) return
      if (removing) {
        const response = await this.host.ask({ type: 'warning', message: tr('移除这台 Cowork 设备？', 'Remove this Cowork device?'),
          detail: tr('设备将在 Cowork 注销，这份协作版的本地数据会移到废纸篓。', 'Cowork will revoke this device and Fig will move its local team data to the Trash.'),
          buttons: [tr('取消', 'Cancel'), tr('移除设备', 'Remove Device')], cancelId: 0, defaultId: 0 })
        if (response !== 1) return
        await this.session?.revokeDevice(removing)
      }
      await this.host.stop()
      if (this.host.quitting()) return
      if (action === 'personal' || action === 'signOut' || removing) {
        if (action === 'signOut') await this.session?.signOut()
        this.selected = false
        this.identity = undefined
        this.activeProfile = undefined
        await writeRecord(this.preference, { edition: 'personal' })
        if (removing) await this.host.trash(join(this.host.userData, 'cowork', 'profiles', removing)).catch(() => {
          this.host.errorBox(tr('设备已注销', 'Device revoked'), tr('无法将协作版数据移到废纸篓。数据仍保留在本机。', 'The team data could not be moved to the Trash and remains on this Mac.'))
        })
        this.screen = undefined
        await this.host.launch(this.host.personalHome())
        return
      }
      this.selected = true
      await this.useSession(action === 'team' && this.screen !== 'waiting')
    })
  }

  /** Writes the organization's business plugin switches into the running Profile's descriptor, for its next start. */
  private async keepPlugins(profile: string, plugins: CoworkIdentity['plugins']) {
    const path = descriptorPath(join(this.host.userData, 'cowork', 'profiles', profile))
    const stored = await readFile(path, 'utf8').then(JSON.parse)
    if (stored && typeof stored === 'object') await writeRecord(path, { ...stored, teamPlugins: plugins })
  }

  /** Confirms the running team Profile still belongs to a signed-in, registered device (window focus and every minute). */
  check(touch: boolean): void {
    const client = this.session
    if (!this.selected || !client || this.screen || this.task || this.host.quitting() || !this.host.attached()) return
    void this.run(async () => {
      try {
        const { identity, profile } = await client.current(undefined, { touch, registeredOnly: true })
        if (profile && profile === this.activeProfile) {
          const before = this.identity
          // Business plugins load at start: a changed switch is kept for the next one. Until the
          // descriptor is written, the identity keeps the earlier switches so the next check tries again.
          const kept = JSON.stringify(before?.plugins ?? {}) === JSON.stringify(identity.plugins)
            || await this.keepPlugins(profile, identity.plugins).then(() => true, () => false)
          this.identity = kept ? identity : { ...identity, plugins: before?.plugins ?? {} }
          if (before?.name !== identity.name || before?.organization?.name !== identity.organization?.name
            || before?.organization?.adminConsoleUrl !== identity.organization?.adminConsoleUrl
            || before?.models.allowPersonal !== identity.models.allowPersonal) this.host.pageChanged()
          return
        }
        await this.host.stop()
        this.identity = identity
        this.screen = profile ? 'expired' : 'waiting'
      } catch (error) {
        if (!(error instanceof CoworkAuthorizationExpired)) return // transport failures are retried on the next check
        await this.host.stop()
        this.identity = undefined
        this.screen = 'expired'
      }
      this.host.changed()
    }, true).catch(() => undefined)
  }
}

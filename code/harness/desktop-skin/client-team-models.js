import { t } from './client-locale.js'
import { modelSource } from '../shared/team-models.ts'
import { watchPage } from '../shared/page-observer.js'

// The composer keeps DSH's own model picker in both editions: its two levels (模型 ›, 推理等级 ›), search and reasoning
// efforts. Fig reorders and badges its groups, greys
// personal ones the tenant closes, and refuses a selection the team policy forbids.
// - Both editions: a source icon before the model name on the trigger, with its hover text, and before each provider heading in the model pane: organization = two buildings,
//   yellow; subscription = a card, green; API key = a key, blue. The personal edition shows the last two (user
//   2026-11-24). DSH's own DeepSeek account has none.
// - Team only: the directory snapshot is projected — organization groups first, named 「<vendor> 组织」, the default
//   organization model badged 默认 — and a selection outside policy is refused at the directory (the composer and
//   /model share it). While personal models are closed, the subscription and API groups are greyed with the reason.
// DSH's orderModelProviders always puts deepseek-official first; organization groups are moved ahead of it with CSS
// `order` (visual only: arrow keys keep DSH's order).
// Icons are CSS on DSH's own `data-provider-id` spans and MenuGroup headings (no element is added to DSH's React tree);
// a local adaptation on DSH 0.2.2-rc.5 until it gives provider groups a slot.

/** @type {Record<import('../shared/team-models.ts').ModelSource, string>} 20×20, stroke 1.6 (prototype srcGlyph). */
export const sourceGlyph = {
  organization: 'M3 16.5h14 M4.5 16.5V4.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v12 M11.5 8h3a1 1 0 0 1 1 1v7.5 M13.5 11v2.5',
  'personal-subscription': 'M4.5 4.5h11A1.5 1.5 0 0 1 17 6v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14V6a1.5 1.5 0 0 1 1.5-1.5Z M3 8.5h14 M6 12.5h3',
  'personal-api': 'M10.6 9.4a4 4 0 1 1 1.6 1.6L5.5 17.7H3.5v-2l.9-.9h1.4v-1.4h1.4l.9-.9z M13.6 6.4h.01'
}
/** Light / dark. */
export const sourceColor = {
  organization: ['#b7860b', '#f2c94c'],
  'personal-subscription': ['#1f9d55', '#3ecf8e'],
  'personal-api': ['#4176e6', '#7aaaff']
}
const mask = d => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`)}")`
export const sourceCss = Object.entries(sourceGlyph).map(([type, d]) =>
  `[data-fig-model-source="${type}"]{--fig-model-source:light-dark(${sourceColor[type][0]},${sourceColor[type][1]});--fig-model-glyph:${mask(d)}}`).join('') + `
[data-fig-model-trigger]{display:inline-flex;align-items:center;gap:5px;min-width:0}
[data-fig-model-heading]{display:flex;align-items:center;gap:6px}
[data-fig-model-trigger]::before,[data-fig-model-heading]::before{content:'';flex:none;width:14px;height:14px;background:var(--fig-model-source);-webkit-mask:var(--fig-model-glyph) center/contain no-repeat;mask:var(--fig-model-glyph) center/contain no-repeat}
[role="menu"]:has(>[role="group"][data-fig-model-source="organization"]){display:flex;flex-direction:column}
[role="menu"]>[role="group"][data-fig-model-source="organization"]{order:-1}
[data-fig-model-blocked] [role="menuitemradio"]{opacity:.45;pointer-events:none}
[data-fig-model-blocked]>[data-fig-model-heading]::after{content:attr(data-fig-model-blocked);margin-inline-start:auto;font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary)}
`

/** Organization groups first, each named 「<vendor> 组织」; the default organization model badged 默认; a platform model
 * that has a namesake among the tenant's own organization APIs badged 计入额度 (it uses team quota; §4.9). */
export function projectTeamGroups(groups, settings, organizationName = name => `${name} ${t('team-models.organizationSuffix')}`,
  text = { default: t('team-models.default'), quota: t('team-models.usesQuota') }) {
  const organization = settings?.organizationProviders ?? []
  const platform = new Set(settings?.platformProviders ?? [])
  const isOrganization = group => organization.includes(group.id)
  const tenantNames = new Set(groups.filter(group => isOrganization(group) && !platform.has(group.id)).flatMap(group => group.models.map(model => model.name)))
  const choice = settings?.defaultModel
  const rename = group => !isOrganization(group) ? group : { ...group, name: organizationName(group.name), models: group.models.map(model => {
    const notes = [...choice?.provider === group.id && choice.model === model.id ? [text.default] : [],
      ...platform.has(group.id) && tenantNames.has(model.name) ? [text.quota] : []]
    return notes.length && !model.badge ? { ...model, badge: { text: notes.join(' · '), tone: 'info' } } : model
  }) }
  return [...groups.filter(isOrganization), ...groups.filter(group => !isOrganization(group))].map(rename)
}

/** Team policy at the directory, the snapshot projection, the source icons and the greyed groups. */
export function installTeamModels(ctx, profile) {
  const sessions = new Map()
  const listeners = new Set()
  let revision = 0
  let livePersonal, team = false
  const changed = () => { revision++; for (const listener of listeners) listener() }
  const settings = () => team ? profile.getSnapshot()?.teamModels : undefined
  const source = provider => modelSource(provider, settings()?.organizationProviders ?? [])
  const restriction = sessionId => !team ? undefined : (livePersonal ?? settings()?.allowPersonal) === false ? t('team-models.tenantOnly')
    : sessions.has(sessionId) ? t('team-models.projectOnly') : undefined
  const allowed = (provider, sessionId) => source(provider) === 'organization' || !restriction(sessionId)
  ctx.provide('figTeamModels', Object.freeze({
    version: 1,
    /** The team plugin owns this binding. Unregister when the Session changes its linked project. */
    restrictPersonal(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return () => {}
      const binding = Symbol()
      sessions.set(sessionId, binding)
      changed()
      return () => { if (sessions.get(sessionId) === binding) { sessions.delete(sessionId); changed() } }
    }
  }))
  const subscribe = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const tips = /** @type {const} */ ({
    organization: ['team-models.tip.organization', 'team-models.personalTip.organization'],
    'personal-subscription': ['team-models.tip.personal-subscription', 'team-models.personalTip.personal-subscription'],
    'personal-api': ['team-models.tip.personal-api', 'team-models.personalTip.personal-api']
  })
  /** @param {import('../shared/team-models.ts').ModelSource} type */
  const tip = type => t(tips[type][team ? 0 : 1])

  // DSH wraps every model name (trigger, root menu, rows) in <span data-provider-id data-model-id>. The trigger's gets the
  // source icon and its hover text; each MenuGroup in the model pane takes the source of its rows.
  let currentSession = () => undefined
  const triggerSelector = '[data-provider-id]'
  function mark() {
    for (const span of document.querySelectorAll(triggerSelector)) {
      if (span.closest('[role="menu"]')) continue
      const type = source(span.getAttribute('data-provider-id') ?? '')
      if (type) { span.setAttribute('data-fig-model-source', type); span.setAttribute('data-fig-model-trigger', ''); span.setAttribute('title', tip(type)) }
      else if (span.hasAttribute('data-fig-model-trigger')) { span.removeAttribute('data-fig-model-source'); span.removeAttribute('data-fig-model-trigger'); span.removeAttribute('title') }
    }
    const reason = restriction(currentSession())
    for (const row of document.querySelectorAll('[role="menu"] [role="menuitemradio"] [data-provider-id]')) {
      const group = row.closest('[role="group"]')
      const heading = group?.querySelector(':scope > [data-menu-group-heading]')
      if (!group || !heading) continue
      const type = source(row.getAttribute('data-provider-id') ?? '')
      if (!type) continue
      if (group.getAttribute('data-fig-model-source') !== type) group.setAttribute('data-fig-model-source', type)
      if (!heading.hasAttribute('data-fig-model-heading')) heading.setAttribute('data-fig-model-heading', '')
      const blocked = type !== 'organization' ? reason : undefined
      if (blocked && group.getAttribute('data-fig-model-blocked') !== blocked) group.setAttribute('data-fig-model-blocked', blocked)
      else if (!blocked && group.hasAttribute('data-fig-model-blocked')) group.removeAttribute('data-fig-model-blocked')
    }
  }

  let active = true, dispose, stopPolicy, stopHeadings, stopMarks
  const style = document.createElement('style')
  style.textContent = sourceCss
  document.head.append(style)
  void profile.ready.then(state => {
    if (!active) return
    team = state?.edition === 'team'
    if (team) stopPolicy = globalThis.__FIG_EDITION__?.subscribe(value => {
      if (typeof value?.allowPersonal === 'boolean') { livePersonal = value.allowPersonal; changed() }
    })
    changed()
    stopHeadings = watchPage({ name: 'model source', childList: true, attributes: ['data-provider-id'], run: mark })
    const unsubscribe = subscribe(mark)
    const stopLocale = ctx.locale.subscribe?.(mark)
    stopMarks = () => { unsubscribe(); stopLocale?.() }
    dispose = ctx.inject(['modelDirectories', 'sessions'], scope => {
      const resolver = scope.modelDirectories
      const before = resolver.directoryFor
      const original = new WeakMap(), directories = []
      currentSession = () => Object.values(scope.sessions.list?.getSnapshot?.().byId ?? {}).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
      resolver.directoryFor = function (sessionId) {
        const directory = before.call(this, sessionId)
        if (original.has(directory)) return directory
        const select = directory.select, read = directory.store.getSnapshot
        // Organization providers come from the Profile, fixed for the launch: one projection per snapshot and language.
        let seen, seenLocale, projected
        const project = () => {
          const snapshot = read.call(directory.store)
          if (!team || !Array.isArray(snapshot?.groups)) return snapshot
          const locale = ctx.locale?.getSnapshot?.().active
          if (snapshot !== seen || locale !== seenLocale) {
            seen = snapshot; seenLocale = locale; projected = { ...snapshot, groups: projectTeamGroups(snapshot.groups, settings()) }
          }
          return projected
        }
        // The composer and /model select through the same directory.
        const wrapped = selection => allowed(selection.provider, sessionId) ? select.call(directory, selection)
          : Promise.resolve({ ok: false, error: { code: 'fig/team-model-policy', message: restriction(sessionId) } })
        original.set(directory, { select, wrapped, read, project })
        directories.push(new WeakRef(directory))
        if (team) { directory.select = wrapped; directory.store.getSnapshot = project }
        return directory
      }
      scope.effect(() => () => {
        resolver.directoryFor = before
        for (const ref of directories) {
          const directory = ref.deref(), entry = directory && original.get(directory)
          if (!entry) continue
          if (directory.select === entry.wrapped) directory.select = entry.select
          if (directory.store.getSnapshot === entry.project) directory.store.getSnapshot = entry.read
        }
      })
    })
  })
  return () => { active = false; stopPolicy?.(); stopHeadings?.(); stopMarks?.(); void dispose?.dispose(); style.remove() }
}

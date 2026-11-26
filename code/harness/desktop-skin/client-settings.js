import { t } from './client-locale.js'
import { settingsActions, slotEntries } from '../shared/dsh-internals.js'
import { watchPage } from '../shared/page-observer.js'
import { accountPieces, button, colors, label, note, row } from '../shared/page-ui.js'
import { pageRpc } from '../shared/page-rpc.js'
import { directoryActionUrl, directoryNonceGlobal, directoryStatusEvent } from '../shared/page-contract.ts'

const call = pageRpc('/fig-skin')
// The parent-rules switch belongs to the instructions package.
const instructions = pageRpc('/fig-instructions')

/** @param {typeof import('react')} react */
export function settingsSections({ createElement: h, useEffect, useState }, { Switch }) {
  // Runtime details keep their own page; composer preferences join DSH General through its item slot.
  // Shared with the account sections: the heading keeps 8px below it and rows 16px padding (were 4px and 14px).
  const { heading, Field } = accountPieces(h)
  const subheading = title => h('h3', { style: { color: colors.primary, margin: '24px 0 8px', fontSize: 14, fontWeight: 500, lineHeight: '22px' } }, title)
  const intro = { ...note, margin: '0 0 16px' }
  const card = { border: '.5px solid ' + colors.border, borderRadius: 12, background: colors.layer, padding: '0 16px', marginBottom: 16 }

  function Row({ title, value, action, last }) {
    return h('div', { style: { ...row, ...(last ? { borderBottom: 'none' } : {}) } },
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: label }, title),
        h('div', { style: { ...note, overflowWrap: 'anywhere' } }, value)),
      action)
  }

  function useSettingsInfo() {
    const [state, setState] = useState(/** @type {{value?: any, error?: string, busy?: boolean}} */ ({}))
    useEffect(() => {
      let active = true
      call('settings/info', {}).then(value => { if (active) setState({ value }) },
        () => { if (active) setState({ error: t('settings.couldNotReadTheFolders') }) })
      const status = event => setState(current => ({...current, busy: event.detail?.busy === true}))
      window.addEventListener(directoryStatusEvent, status)
      return () => { active = false; window.removeEventListener(directoryStatusEvent, status) }
    }, [])
    return state
  }

  function DirectoryActions({ directory, label, disabled, busy, previous, onError, clear = false, openable = true }) {
    const configure = kind => window.open(directoryActionUrl(kind, window[directoryNonceGlobal]), '_blank', 'noopener')
    return h('div', {style: {display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', flexShrink: 0}},
      h('button', {type: 'button', style: button, disabled: disabled || busy, 'aria-label': t('settings.set') + label,
        onClick: () => configure(directory)}, t('settings.setFolder')),
      h('button', {
      type: 'button', style: button, disabled: disabled || !openable, 'aria-label': t('settings.open') + label,
      onClick: () => call('settings/open', { directory }).catch(() => onError(t('settings.couldNotOpenThisFolder')))
      }, t('settings.openButton')),
      previous && h('button', {type: 'button', style: button, disabled: busy, onClick: () => configure('restoreDshHome')}, t('settings.restorePrevious')),
      clear && h('button', {type: 'button', style: button, disabled: disabled || busy, 'aria-label': t('settings.clear') + label,
        onClick: () => configure('clearSkillDirectory')}, t('settings.clearMenu')))
  }

  // Ancestor AGENTS.md files between the startup folder and the project's Git root; takes effect on the next turn.
  // The switch belongs to the instructions package; `initial` is its setting, read by WorkspaceSection.
  function InstructionsSwitch({ initial, onError }) {
    const [enabled, setEnabled] = useState(initial)
    const [busy, setBusy] = useState(false)
    const toggle = checked => {
      setBusy(true); onError('')
      return instructions('enable', { enabled: checked }).then(value => setEnabled(value.enabled),
        () => onError(t('settings.couldNotSaveThisSetting'))).finally(() => setBusy(false))
    }
    return h(Switch, { label: t('settings.parentFolderRules'), checked: enabled === true, disabled: busy, onChange: toggle })
  }

  /** The instructions package's switch: undefined while reading, null when that package is not loaded (switched off on the Plugins page). */
  function useInstructionsSetting() {
    const [setting, setSetting] = useState(/** @type {{ enabled: boolean } | null | undefined} */ (undefined))
    useEffect(() => {
      let active = true
      instructions('settings', {}).then(value => { if (active) setSetting(value) }, () => { if (active) setSetting(null) })
      return () => { active = false }
    }, [])
    return setting
  }

  function SectionBody({ title, description = '', rows, state }) {
    const { value, error, busy } = state
    const [actionError, setActionError] = useState('')
    const loading = t('settings.loading')
    return h('div', null, subheading(title), description && h('p', { style: intro }, description),
      h('div', { style: card }, rows(value, loading, setActionError, busy).map((row, index, all) => h(Row, { key: row.title, ...row, last: index === all.length - 1 }))),
      (error || actionError) && h('p', { role: 'alert', style: { ...intro, color: 'var(--dsw-alias-label-danger, #d33)' } }, error || actionError))
  }

  function WorkspaceSection({ state }) {
    const rules = useInstructionsSetting()
    return h(SectionBody, {
      state,
      title: t('settings.workspace'),
      description: t('settings.setTheFigStartupFolder'),
      rows: (value, loading, onError, busy) => [
        { title: t('settings.startupFolder'), value: value?.startup ?? loading,
          action: h(DirectoryActions, { directory: 'startup', label: t('settings.startupFolderInline'), disabled: !value, busy, previous: false, onError }) },
        { title: t('settings.dshDefaultWorkspace'), value: value ? value.defaultWorkspace ?? t('settings.noDefaultWorkspaceFound') : loading,
          action: h(DirectoryActions, { directory: 'defaultWorkspace', label: t('settings.defaultWorkspaceFolder'), disabled: !value, busy, previous: false, onError }) },
        { title: t('settings.extraSkillFolder'), value: value ? value.skillDirectory ?? t('settings.notSetDshsOwnSkill') : loading,
          action: h(DirectoryActions, { directory: 'skillDirectory', label: t('settings.extraSkillFolderInline'), disabled: !value, busy, previous: false, onError,
            clear: Boolean(value?.skillDirectory), openable: Boolean(value?.skillDirectory) }) },
        // Shown only while the instructions package is loaded.
        ...rules === null ? [] : [{ title: t('settings.parentFolderRules'),
          value: t('settings.readsAgentsMdInEach'),
          action: rules === undefined ? null : h(InstructionsSwitch, { initial: rules.enabled, onError }) }]
      ]
    })
  }

  // Fig starts the newest DSH release it has verified; a newer npm latest waits for verification.
  function dshStatus(dsh) {
    if (!dsh?.running) return t('settings.dshVersionUnavailable')
    const running = dsh.running + (dsh.verified ? t('settings.verified') : t('settings.notVerifiedVerificationRun'))
    if (!dsh.latest || dsh.latest === dsh.running) return running
    return running + t(dsh.latestVerified ? 'settings.latestVerified' : 'settings.latestNotSupported', { latest: dsh.latest })
  }

  function RuntimeInfo({ state }) {
    return h(SectionBody, {
      state,
      title: t('settings.runtimeInformation'),
      rows: (value, loading, onError, busy) => [
        { title: t('settings.dshVersion'), value: value ? dshStatus(value.dsh) : loading },
        { title: 'Node.js', value: value?.nodeVersion ?? loading },
        { title: t('settings.dshDataFolder'), value: value?.dshHome ?? loading,
          action: h(DirectoryActions, { directory: 'dshHome', label: t('settings.dshDataFolderInline'), disabled: !value, busy, previous: Boolean(value?.previousDshHome), onError }) }
      ]
    })
  }

  function RuntimeSection() {
    const state = useSettingsInfo()
    return h('div', { 'data-fig-runtime-settings': '' },
      heading(t('settings.runtime')),
      h('p', { style: intro }, t('settings.configureWorkspaceAndDataFolders')),
      h(WorkspaceSection, { state }), h(RuntimeInfo, { state }))
  }

  // The app menu's Settings… asks the page to open Fig's unified Runtime section.
  function openSettings(ctx) {
    const actions = settingsActions(ctx)
    if (typeof actions?.openSection === 'function') actions.openSection('fig-runtime')
    else console.warn('[fig-desktop-skin] DSH settings could not be opened from the menu')
  }

  // The dialog's title row: 设置 on the left, DSH's own close button on the right (app/main/workbench.css).
  function SettingsHeader() { return t('settings.settings') }

  return { RuntimeSection, SettingsHeader, openSettings }
}

/**
 * Team plugins' settings sections go last in the dialog's list, under a 协作版 label.
 * DSH 0.2.2-rc.1 renders the list without ids, in its registrations' order, and its
 * registrations do not say which plugin made them (the registrant is a minified name), so the rule is by id: in a team
 * Profile, a section whose id starts with `cowork-` is a team plugin's (a naming rule team plugins follow). A cell
 * is matched to its registration by position and marked; app/main/workbench.css moves marked cells last and draws the
 * label. When the cells and registrations do not line up, nothing is marked. Re-check on each
 * DSH upgrade (npm run dsh:verify).
 */
export const teamSection = id => typeof id === 'string' && id.startsWith('cowork-')

export function installSettingsGroups(ctx, profile) {
  const marked = new Set()
  function mark() {
    const list = document.querySelector('[data-shortcut-modal="settings"] > nav > div')
    const cells = list ? [...list.children].filter(node => node.tagName === 'BUTTON') : []
    const entries = [...slotEntries(ctx, 'settings.section')].filter(entry => entry?.options?.id)
      .map((entry, index) => ({ id: entry.options.id, order: entry.options.order ?? 0, index }))
      .sort((a, b) => a.order - b.order || a.index - b.index)
    const team = profile.getSnapshot()?.edition === 'team' && cells.length === entries.length
    let first = true
    for (const [index, cell] of cells.entries()) {
      const grouped = team && teamSection(entries[index].id)
      cell.toggleAttribute('data-fig-settings-group', grouped)
      if (grouped && first) { cell.setAttribute('data-fig-settings-group-first', t('settings.teamEdition')); first = false }
      else cell.removeAttribute('data-fig-settings-group-first')
      if (grouped) marked.add(cell)
    }
  }
  const stop = watchPage({ name: 'settings groups', childList: true, within: '[data-shortcut-modal="settings"]', run: mark })
  const unsubscribe = profile.subscribe(mark)
  mark()
  return () => {
    stop(); unsubscribe()
    for (const cell of marked) { cell.removeAttribute('data-fig-settings-group'); cell.removeAttribute('data-fig-settings-group-first') }
  }
}

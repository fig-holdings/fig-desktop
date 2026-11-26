import { accountPieces, colors, note } from '../shared/page-ui.js'
import { t } from './client-locale.js'
import { pageRpc } from '../shared/page-rpc.js'
const call = pageRpc('/fig-attention', { unavailable: () => t('preferences.unavailable'), failed: () => t('preferences.updateFailed') })

/** Existing DSH setting typography/tokens and native focus order, no independent visual system. */
export function attentionSettings({createElement: h, useState, useEffect}, {Switch}) {
  const { Field } = accountPieces(h)
  return function AttentionPreferences() {
    const [value, setValue] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    // Shown only where a desktop shell turns these into notifications and a Dock badge (`alerts` in info).
    const [alerts, setAlerts] = useState(undefined)
    useEffect(() => { let active = true; call('info').then(info => { if (active) { setAlerts(info.alerts === true); setValue(info.preferences) } }, e => { if (active) setError(e.message) }); return () => { active = false } }, [])
    const update = async (key, checked) => {
      const previous = value
      setValue({...value, [key]: checked}); setBusy(true); setError('')
      try { setValue(await call('preferences', {[key]: checked})) } catch (error) { setValue(previous); setError(error instanceof Error ? error.message : t('preferences.couldNotUpdateAlertPreferences')) } finally { setBusy(false) }
    }
    if (alerts === false) return null
    return h('div', {'data-fig-attention-settings': ''},
      h('h3', {style: {color: colors.primary, fontSize: 14, fontWeight: 500, lineHeight: '22px', margin: '24px 0 8px'}}, t('preferences.taskAlerts')),
      ...[
        ['notifications', t('preferences.importantBackgroundNotifications'), t('preferences.approvalsQuestionsFailuresAndNew')],
        ['dock', t('preferences.dockBadgeForAttentionNeeded'), t('preferences.countsSessionsAwaitingInputOr')]
      ].map(([key, title, description]) => h(Field, {key, title, description}, h(Switch, {checked: value?.[key] ?? false, disabled: !value || busy, label: title, onChange: checked => { void update(key, checked) }}))),
      !value && !error && h('p', {style: note, role: 'status'}, t('preferences.loading')),
      error && h('p', {role: 'alert', style: note}, error))
  }
}

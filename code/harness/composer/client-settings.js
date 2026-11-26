import { t } from './client-locale.js'
import { accountPieces, colors, note } from '../shared/page-ui.js'
import { pageRpc } from '../shared/page-rpc.js'

const call = pageRpc('/fig-composer')

/** 输入框 under DSH Settings › General: the next-step hint switch. @param {typeof import('react')} react */
export function composerSettings({ createElement: h, useEffect, useState }, { Switch }) {
  const { Field } = accountPieces(h)
  function ComposerSection() {
    const [enabled, setEnabled] = useState()
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    useEffect(() => {
      let active = true
      call('next-step/settings', {}).then(value => { if (active) setEnabled(value.enabled) },
        () => { if (active) setError(t('settings.couldNotReadThisSetting')) })
      return () => { active = false }
    }, [])
    const toggle = checked => {
      setBusy(true); setError('')
      return call('next-step/enable', { enabled: checked }).then(value => setEnabled(value.enabled),
        () => setError(t('settings.couldNotSaveThisSetting'))).finally(() => setBusy(false))
    }
    // A row like 任务提醒 above it (the task-activity package), with the explanation alone beside the switch under 输入框.
    // The switch keeps its accessible name.
    const title = t('settings.nextStepHint')
    return h('div', { 'data-fig-composer-settings': '' }, h('h3', { style: { color: colors.primary, margin: '24px 0 8px', fontSize: 14, fontWeight: 500, lineHeight: '22px' } }, t('settings.composer')),
      h(Field, { description: t('settings.afterEachTurnTheSessions') },
        h(Switch, { label: title, checked: enabled === true, disabled: enabled === undefined || busy, onChange: toggle })),
      error && h('p', { role: 'alert', style: { ...note, margin: '0 0 16px', color: 'var(--dsw-alias-label-danger, #d33)' } }, error))
  }

  return ComposerSection
}

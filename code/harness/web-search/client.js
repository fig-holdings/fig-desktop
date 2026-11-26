import { accountPieces, button, note } from '../shared/page-ui.js'
import { pageLocale } from '../shared/page-locale.js'
import { pageRpc } from '../shared/page-rpc.js'

const { t, install } = pageLocale('fig.web-search', {
  title: '联网搜索', mode: '搜索方式', follow: '跟随当前模型', independent: '使用独立搜索服务（Brave）',
  other: '当前 DSH 提供方', key: 'Brave Search API Key', stored: '已配置', empty: '尚未配置',
  managed: '搜索方式由协作版设置提供。', save: '保存密钥', clear: '移除已保存的密钥', failed: '联网搜索设置操作失败。', retry: '重试'
}, {
  title: 'Web search', mode: 'Search mode', follow: 'Follow current model', independent: 'Use independent search (Brave)',
  other: 'Current DSH provider', key: 'Brave Search API key', stored: 'Configured', empty: 'Not configured',
  managed: 'Search modes are provided by the team edition.', save: 'Save key', clear: 'Remove stored key', failed: 'Could not update web search settings.', retry: 'Retry'
})
const call = pageRpc('/fig-web-search')
window.__ModuleLoader__.load({
  id: '@local/dsh-web-search',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react')
    const { heading, Field } = accountPieces(h)
    function Section() {
      const [state, setState] = useState(/** @type {{ selected?: string|null, configured?: boolean, managed?: boolean }|null} */ (null)), [key, setKey] = useState('')
      const [busy, setBusy] = useState(false), [failure, setFailure] = useState(false)
      useEffect(() => {
        let active = true
        call('status').then(value => { if (active) setState(value) }, () => { if (active) setFailure(true) })
        return () => { active = false }
      }, [])
      async function change(endpoint, payload = {}) {
        setBusy(true)
        setFailure(false)
        try {
          if (endpoint !== 'status') await call(endpoint, payload)
          setKey('')
          setState(await call('status'))
        } catch { setFailure(true) } finally { setBusy(false) }
      }
      const known = ['fig-follow-model', 'fig-brave-search'].includes(state?.selected ?? '')
      return h('section', null, heading(t('title')),
        state?.managed && h('p', { style: note }, t('managed')),
        state && !state.managed && h(Field, { title: t('mode') },
          h('select', { style: button, 'aria-label': t('mode'), value: known ? (state.selected ?? '') : '', disabled: busy,
            onChange: event => change('select', { mode: /** @type {HTMLSelectElement} */ (event.currentTarget).value }) },
          !known && h('option', { value: '', disabled: true }, state.selected || t('other')),
          h('option', { value: 'fig-follow-model' }, t('follow')), h('option', { value: 'fig-brave-search' }, t('independent')))),
        state?.selected === 'fig-brave-search' && h('div', null,
          h(Field, { title: t('key'), description: state.configured ? t('stored') : t('empty') },
            h('input', { type: 'password', autoComplete: 'new-password', 'aria-label': t('key'), value: key, disabled: busy,
              style: { ...button, width: '38%', minWidth: 80 }, onChange: event => setKey(/** @type {HTMLInputElement} */ (event.currentTarget).value) })),
          h('button', { style: button, disabled: busy || !key.trim(), onClick: () => change('key', { key }) }, t('save')),
          state.configured && h('button', { style: button, disabled: busy, onClick: () => change('clear') }, t('clear'))),
        failure && h('div', { role: 'alert', style: note }, t('failed'), ' ',
          h('button', { style: button, disabled: busy, onClick: () => change('status') }, t('retry'))))
    }
    return { inject: ['slots', 'locale'], apply(ctx) {
      install(ctx)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'fig-web-search', order: -7, label: () => t('title')
      }, Section))
    } }
  }
})

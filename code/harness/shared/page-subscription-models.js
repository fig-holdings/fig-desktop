import { button, label, note } from './page-ui.js'

const styles = `
.fig-subscription-models { padding-block: 16px; min-width: 0; }
.fig-subscription-models header, .fig-subscription-models footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.fig-subscription-models details { margin-top: 12px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-settings-card-fill); }
.fig-subscription-models summary { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 10px 12px; cursor: pointer; list-style: none; border-radius: inherit; }
.fig-subscription-models summary::-webkit-details-marker { display: none; }
.fig-subscription-models summary::before { content: ''; width: 5px; height: 5px; border: solid currentColor; border-width: 0 1px 1px 0; transform: rotate(-45deg); margin-inline-end: 3px; }
.fig-subscription-models details[open] summary::before { transform: translateY(-2px) rotate(45deg); }
.fig-subscription-models summary:hover, .fig-subscription-models label:hover { background: var(--dsw-alias-interactive-bg-hover); }
.fig-subscription-models summary:focus-visible, .fig-subscription-models input:focus-visible, .fig-subscription-models button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.fig-subscription-models fieldset { margin: 0; padding: 0; min-width: 0; border: 0; }
.fig-subscription-models ul { max-block-size: 17rem; overflow-y: auto; margin: 0; padding: 0 12px; list-style: none; }
.fig-subscription-models li { border-top: .5px solid var(--dsw-alias-border-l2); }
.fig-subscription-models label { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px; min-height: 40px; padding: 4px; cursor: pointer; }
.fig-subscription-models label:has(input:disabled) { cursor: default; }
.fig-subscription-models input { margin: 0; width: 16px; height: 16px; accent-color: var(--dsw-alias-brand-primary); }
.fig-subscription-models code { overflow-wrap: anywhere; }
.fig-subscription-models footer { border-top: .5px solid var(--dsw-alias-border-l2); padding: 8px 12px; justify-content: flex-end; }
.fig-subscription-models button:disabled { opacity: .5; cursor: default !important; }
`

// This uses the settings page's native checkbox pattern without depending on its private components.
export function subscriptionModels({ createElement: h, useEffect, useRef, useState }, call, t) {
  return function Models() {
    const [data, setData] = useState(null)
    const [draft, setDraft] = useState([])
    const [busy, setBusy] = useState('load')
    const [message, setMessage] = useState(null)
    const seq = useRef(0)
    const removesModels = data?.selected.some(id => !draft.includes(id))
    const dirty = !!data && (removesModels || draft.length !== data.selected.length)

    async function update(kind) {
      const request = ++seq.current
      setBusy(kind)
      setMessage(null)
      try {
        const next = kind === 'save' ? await call('models/save', { ids: draft }) : await call('models', { refresh: kind === 'refresh' })
        if (request !== seq.current) return
        setData(next)
        setDraft(dirty && kind === 'refresh' ? draft.filter(id => next.models.some(row => row.id === id && row.input)) : next.selected)
        if (kind === 'save') setMessage({ text: t('main.menuSaved') })
      } catch (error) {
        if (request === seq.current) setMessage({ error: true, text: error instanceof Error ? error.message : String(error) })
      } finally {
        if (request === seq.current) setBusy(null)
      }
    }
    useEffect(() => { void update('load'); return () => { seq.current++ } }, [])

    return h('section', { className: 'fig-subscription-models', 'aria-label': t('main.modelMenu') },
      h('style', null, styles),
      h('header', null, h('div', null, h('div', { style: label }, t('main.modelMenu')),
        h('div', { style: note }, t('main.modelMenuHint'))),
      h('button', { type: 'button', style: button, disabled: !!busy, onClick: () => update('refresh') }, t('main.refreshModels'))),
      data?.models.length ? h('details', null,
        h('summary', { style: label }, t('main.chooseModels'), h('span', { style: note },
          t('main.menuCount', { count: data.selected.length, total: data.models.filter(row => row.input).length }))),
        h('fieldset', { disabled: !!busy, 'aria-label': t('main.chooseModels') },
          h('ul', null, data.models.map(({ id, input }) => h('li', { key: id }, h('label', { style: label },
            h('input', { type: 'checkbox', 'aria-label': id, checked: draft.includes(id), disabled: !input,
              onChange: event => { const checked = event.target.checked; setDraft(ids => checked ? [...ids, id] : ids.filter(item => item !== id)) } }),
            h('span', null, h('code', null, id), !input || input.includes('image')
              ? h('span', { style: { ...note, display: 'block' } }, t(input ? 'main.imageInput' : 'main.unknownModel')) : null))))),
          h('footer', null,
            removesModels && h('span', { style: { ...note, flex: '1 0 100%' } }, t('main.hiddenModelHint')),
            dirty && h('button', { type: 'button', style: button, onClick: () => { setDraft(data.selected); setMessage(null) } }, t('main.resetModels')),
            h('button', { type: 'button', style: button, disabled: !dirty, onClick: () => update('save') }, t('main.saveModels')))))
        : data && h('div', { style: { ...note, paddingTop: 8 } }, t('main.noModels')),
      busy && h('div', { style: { ...note, paddingTop: 8 }, role: 'status' }, t(busy === 'save' ? 'main.savingModels' : 'main.loading')),
      message && h('div', { style: { ...note, paddingTop: 8 }, role: message.error ? 'alert' : 'status' }, message.text))
  }
}

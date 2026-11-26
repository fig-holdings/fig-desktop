import { openSessionId } from '../shared/page-client.js'
import { t } from './client-locale.js'
import { colors, note, button } from '../shared/page-ui.js'
import { pageRpc } from '../shared/page-rpc.js'

const call = pageRpc('/fig-rule-sources')

export function ruleComponents({createElement: h, useState, useEffect}, primitives) {
  const { Modal, MenuItemButton, IconDocumentOutlineRegular } = primitives
  let request
  const listeners = new Set()
  const emit = () => { for (const listener of listeners) listener(request) }
  function RuleMenuRow({onDismiss}) {
    return h(MenuItemButton, {icon: IconDocumentOutlineRegular ? h(IconDocumentOutlineRegular, {size: 16}) : undefined,
      onSelect: () => {
        const sessionId = openSessionId()
        if (!sessionId) return
        const focus = document.activeElement
        onDismiss?.()
        // Let the native menu restore its focus before the Modal takes ownership.
        requestAnimationFrame(() => { request = {sessionId, focus}; emit() })
      }}, t('rules.ruleSources'))
  }
  const status = value => ({included: t('rules.included'), truncated: t('rules.truncated'), 'omitted-size': t('rules.tooLargeNotRead'), 'omitted-budget': t('rules.omittedByBudget')})[value] ?? t('rules.unknown')
  function RuleDialog() {
    const [target, setTarget] = useState(request)
    const [state, setState] = useState({})
    const [revision, setRevision] = useState(0)
    useEffect(() => { listeners.add(setTarget); return () => { listeners.delete(setTarget) } }, [])
    useEffect(() => {
      if (!target) return
      let active = true; setState({loading: true})
      call('info', {sessionId: target.sessionId}).then(value => { if (active) setState({value}) }, () => { if (active) setState({error: true}) })
      return () => { active = false }
    }, [target, revision])
    const close = () => {
      const previous = target
      request = undefined; setTarget(undefined)
      requestAnimationFrame(() => { if (previous?.focus?.isConnected) previous.focus.focus() })
    }
    const list = (heading, sections) => h('section', null,
      h('h3', {style: {fontSize: 14, margin: '18px 0 8px', color: colors.primary}}, heading),
      sections?.length ? h('ul', {style: {padding: '0 0 0 18px', margin: 0}}, sections.map((section, index) => h('li', {key: index + section.path, style: {marginBottom: 10}},
        h('div', {style: {overflowWrap: 'anywhere', color: colors.primary}}, section.path),
        h('div', {style: note}, status(section.status) + ' · ' + (section.contentDigest === 'unknown' ? t('rules.versionUnknown') : section.contentDigest?.slice(0, 12))))))
        : h('p', {style: note}, t('rules.noConfirmedSharedSources')))
    const value = state.value
    return h(Modal, {open: Boolean(target), onClose: close, title: t('rules.ruleSources'), closeLabel: t('rules.close'),
      footer: h('button', {type: 'button', style: button, onClick: () => setRevision(v => v + 1), disabled: state.loading}, t('rules.refreshList'))},
      h('div', {'data-fig-rules': '', style: {maxHeight: '65vh', overflow: 'auto', fontSize: 14, lineHeight: '22px'}},
        state.loading && h('p', {role: 'status'}, t('rules.loading')),
        state.error && h('p', {role: 'alert'}, t('rules.couldNotReadRulesRefresh')),
        value && h('div', null,
          value.status !== 'off' && h('p', {style: note}, value.status === 'matching' ? t('rules.figSharedRulesMatchThe') : value.status === 'changed' ? t('rules.filesChangedTheLastInjected') : t('rules.injectedSourcesAreUnknownOpen')),
          value.cwd && h('p', {style: {overflowWrap: 'anywhere'}}, t('rules.currentFolder') + value.cwd),
          value.injectedCwd && value.injectedCwd !== value.cwd && h('p', {style: note}, t('rules.folderAtInjection') + value.injectedCwd),
          list(t('rules.lastInjectedFigSharedLayer'), value.injected),
          // With the instructions package off nothing is injected on the next step, so no file is listed for it.
          value.status === 'off' ? h('p', {style: {...note, marginTop: 18}}, t('rules.theInstructionsPackageIsOff'))
            : list(t('rules.currentFilesNextStep'), value.current),
          h('h3', {style: {fontSize: 14, marginBottom: 4}}, t('rules.dshProjectLayer')),
          h('p', {style: note}, t('rules.sourcesCannotBeConfirmedStructurally')),
          value.guidance && h('p', {style: note}, t('rules.figBehaviorGuidanceVersion') + value.guidance),
          value.checkedAt && h('p', {style: note}, t('rules.readAt') + new Date(value.checkedAt).toLocaleTimeString()))))
  }
  return {RuleMenuRow, RuleDialog}
}

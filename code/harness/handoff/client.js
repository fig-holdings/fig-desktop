import { useStore } from '../shared/page-client.js'
import { install, t } from './client-locale.js'
import { argsOf, metaOf, registerToolView, resultText, toolViews } from '../shared/page-tool-view.js'

// handoff_session's row in the conversation: the new session's title, whether it is still running, and a button that
// opens it. The handoff prompt shows when the row is opened.
window.__ModuleLoader__.load({
  id: '@local/dsh-handoff',
  factory(require) {
    const react = require('react')
    const { createElement: h } = react
    const { Row, Text } = toolViews(react)

    const views = ctx => function HandoffView(owner) {
      const meta = metaOf(owner, 'fig-handoff'), args = argsOf(owner)
      const sessions = useStore(react, ctx.sessions?.list, undefined)
      const session = meta ? sessions?.byId?.[meta.sessionId] : undefined
      const title = session?.title || meta?.title || args.title || t('main.untitled')
      const status = !meta ? undefined : !session ? t('main.archivedOrUnavailable') : session.running ? t('main.running') : t('main.stopped')
      const prompt = typeof args.prompt === 'string' ? args.prompt : owner.phase === 'result' ? resultText(owner.block) : ''
      return h(Row, { owner, tool: 'handoff_session', title: t('main.newSession'), summary: title,
        aside: meta ? [
          h('span', { key: 'status', className: 'fig-tool-tag', 'data-fig-handoff-status': session ? (session.running ? 'running' : 'stopped') : 'missing' }, status),
          h('button', { key: 'open', type: 'button', className: 'fig-tool-button', 'data-fig-handoff-open': meta.sessionId, disabled: !session,
            onClick: () => ctx.uiWorkspace.openSession(meta.sessionId) }, t('main.open'))
        ] : undefined },
      prompt ? h(Text, null, prompt) : undefined)
    }

    return {
      inject: ['slots', 'sessions', 'uiWorkspace', 'locale'],
      apply(ctx) { install(ctx); registerToolView(ctx, 'handoff_session', views(ctx)) }
    }
  }
})

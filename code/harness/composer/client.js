import { install } from './client-locale.js'
import { inputHistory, installHintStyle } from './client-history.js'
import { queueNotice } from './client-queue.js'
import { composerSettings } from './client-settings.js'

// The composer's page half: ↑/↓ input history and the greyed next-step hint in the empty input (Tab fills it), the note that
// stopping keeps queued messages, and the 输入框 switch under DSH Settings › General.
window.__ModuleLoader__.load({
  id: '@local/dsh-composer',
  factory(require) {
    const react = require('react')
    // DSH packages come from the factory's loader. Through this name the type checker does not try to resolve them.
    const loadModule = require
    const { Switch } = loadModule('@deepseek-ai/dsh-client-ui-primitives')
    const { historyCache, HistoryDock } = inputHistory(react)
    const QueueNotice = queueNotice(react.createElement)
    const ComposerSection = composerSettings(react, { Switch })
    return {
      inject: ['slots', 'sessions', 'conversation', 'inputTriggers', 'locale'],
      apply(ctx) {
        install(ctx)
        const h = react.createElement
        ctx.effect(() => installHintStyle())
        const history = historyCache()
        const seen = new WeakMap()
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
          { name: 'conversation.input.dock', id: 'fig-input-history', order: -100 },
          props => h(HistoryDock, { ctx, sessionId: props.session.sessionId, history, seen })
        ))
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
          { name: 'conversation.input.dock', id: 'fig-stop-queue-notice', order: 100 }, QueueNotice
        ))
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item', id: 'fig-composer', order: 81
        }, ComposerSection))
      }
    }
  }
})

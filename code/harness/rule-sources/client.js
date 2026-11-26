import { install } from './client-locale.js'
import { ruleComponents } from './client-rules.js'

// 规则来源 in the session header's views menu, and the dialog that lists the open session's rule files.
window.__ModuleLoader__.load({
  id: '@local/dsh-rule-sources',
  factory(require) {
    const react = require('react')
    // DSH packages come from the factory's loader. Through this name the type checker does not try to resolve them.
    const loadModule = require
    const { RuleMenuRow, RuleDialog } = ruleComponents(react, loadModule('@deepseek-ai/dsh-client-ui-primitives'))
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        install(ctx)
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'fig-rules-dialog' }, RuleDialog))
        ctx.slots.inject('conversation.session.header.views.actions', () => ctx.slots.register({ name: 'conversation.session.header.views.actions', id: 'fig-rules', order: 90 }, RuleMenuRow))
      }
    }
  }
})

import { install, t } from './client-locale.js'
import { taskActivityPanel as activityPanel } from '../shared/profile-contract.ts'
import { activityComponents, installActivity, sessionStore } from './client-dynamics.js'
import { usageStore } from './client-usage.js'
import { attentionSettings } from './client-preferences.js'
import { activityExtensions } from './client-extensions.js'

/** A figProfile that may arrive after this plugin, or leave: a store over whichever is attached. */
function profileHolder() {
  let service, stop = () => {}
  const listeners = new Set()
  const publish = () => { for (const listener of listeners) listener() }
  return {
    attach(next) { stop(); service = next; stop = next?.subscribe(publish) ?? (() => {}); publish() },
    getSnapshot: () => service?.getSnapshot(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
}

// Task activity and its usage heat map, next to the Host data they show (index.js), and 任务提醒 under Settings › General.
window.__ModuleLoader__.load({
  id: '@local/dsh-attention',
  factory(require) {
    const react = require('react')
    // DSH packages come from the factory's loader. Through this name the type checker does not try to resolve them.
    const loadModule = require
    const AttentionPreferences = attentionSettings(react, { Switch: loadModule('@deepseek-ai/dsh-client-ui-primitives').Switch })
    return {
      inject: ['slots', 'uiWorkspace', 'layout', 'figUi', 'locale'],
      apply(ctx) {
        install(ctx)
        // Other plugins' views, figures, blocks, session tags and projects (client-extensions.js).
        const usage = usageStore()
        const extensions = activityExtensions({sessions: sessionStore, usage})
        ctx.provide('figActivity', extensions)
        // The Profile's edition and Task activity layout, from desktop-skin's figProfile once it is there (none in DSH Web).
        const profile = profileHolder()
        ctx.inject(['figProfile'], scope => { profile.attach(scope.figProfile); scope.effect(() => () => profile.attach(undefined)) })
        const {ActivityIcon, ActivityPanel} = activityComponents(react, ctx, ctx.figUi, extensions, profile, usage)
        ctx.slots.inject('main', () => ctx.slots.register({name: 'main', key: activityPanel}, ActivityPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({name: 'sidebar.panellist', id: activityPanel, order: -20, label: () => t('main.taskActivity')}, ActivityIcon))
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({name: 'settings.general.item', id: 'fig-task-alerts', order: 80}, AttentionPreferences))
        ctx.effect(() => installActivity(ctx))
      }
    }
  }
})

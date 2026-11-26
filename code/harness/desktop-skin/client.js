import { install, t } from './client-locale.js'
import { filePathAtGlobal, openSettingsEvent } from '../shared/page-contract.ts'
import { extendMoreMenu } from './client-more-menu.js'
import { limitLanguageMenu } from './client-languages.js'
import { remindOverlaps } from './client-plugin-overlaps.js'
import { installSettingsGroups, settingsSections } from './client-settings.js'
import { customPluginsTab } from './client-custom-plugins.js'
import { teamPluginsCss, teamPluginsTab } from './client-team-plugins.js'
import { installBrand } from './client-brand.js'
import { installSidebarIcons } from './client-sidebar-icons.js'
import { installRailToggle } from './client-rail-toggle.js'
import { installProcessDefault } from './client-process.js'
import { installPageNavigation } from './client-navigation.js'
import { installTeamModels } from './client-team-models.js'
import { installEdition } from './client-edition.js'
import { installTranscript } from './client-transcript.js'
import { sessionMenuComponent } from './client-session-menu.js'
import { applyPins, foldPlugins, lockRequired, profileComponents, profileStore, relayStore } from './client-profile.js'
import { installWorkspacePicker, workspacePickerSections } from './client-workspace-picker.js'
import { installTeamFileActions, teamFileActions } from './client-team-files.js'
import { teamSessions } from './client-team-sessions.js'

// Fig Desktop's skin over the DSH page. Everything here either fits DSH's internal structure to the desktop window
// (the settings dialog's size and section groups, the collapsed rail's toggle, one … menu in the top bar) or is a Fig product choice
// (the Runtime settings section, Chinese and English only, reminders about plugins that duplicate a Fig feature), and
// the page globals Fig's main process calls for its menus and settings. It is loaded only by Fig Desktop and checked first on a DSH upgrade.
window.__ModuleLoader__.load({
  id: '@local/dsh-desktop-skin',
  factory(require) {
    const react = require('react')
    const { createElement: h } = react
    // DSH packages come from the factory's loader. Through this name the type checker does not try to resolve them.
    const loadModule = require
    const primitives = loadModule('@deepseek-ai/dsh-client-ui-primitives')
    const { Switch } = primitives
    const { RuntimeSection, SettingsHeader, openSettings } = settingsSections(react, { Switch })
    const { CustomPlugins, css: customPluginsCss } = customPluginsTab(react, { Switch })
    // This Profile's edition and look (client-profile.js), read once per page.
    const profile = profileStore()
    // The Plugins panel's fold (foldPlugins), filled in once the plugin applies.
    const pluginsPanel = relayStore()
    const { PanelRows, FoldedViews, RequiredNotice } = profileComponents(react, primitives, profile, pluginsPanel)
    // Other plugins' sections in the new session's workspace picker (client-workspace-picker.js).
    const pickerSections = workspacePickerSections()
    const fileActions = teamFileActions()

    function SidebarSettings({ ctx, t }) {
      const label = t('trigger')
      const { IconSettingsOutlineMedium } = primitives
      return h('button', {
        type: 'button', 'data-fig-sidebar-settings': '', 'aria-label': label, title: label,
        'aria-haspopup': 'dialog', onClick: () => openSettings(ctx)
      }, h(IconSettingsOutlineMedium, { size: 16 }))
    }

    // The top bar keeps one … menu: DSH's views menu moves to where the session header's own … was
    // (app/main/workbench.css), and this row set adds that header's actions (copy, Session log, open in an
    // application, feedback) to it through DSH's public context-menu service (client-session-menu.js).
    function SessionActionRows(ctx) {
      const SessionMenu = sessionMenuComponent(react, primitives, ctx)
      return function SessionActions(props) {
        return h(react.Fragment, null, h(FoldedViews, props), h(SessionMenu, { onDismiss: props.onDismiss }))
      }
    }

    // Fig's native context menu (app/main/index.ts) asks for the file under the pointer to offer
    // 复制路径. Changed-file cards carry the absolute path in their aria-describedby text. File
    // mentions and delivered cards have DSH's own 复制文件路径.
    function filePathAt(x, y) {
      const target = document.elementFromPoint(x, y)
      if (!target) return undefined
      const described = target.closest('[aria-describedby]')?.getAttribute('aria-describedby')
      const changed = described && document.getElementById(described)?.textContent
      return changed?.startsWith('/') ? changed : undefined
    }

    return {
      inject: ['slots', 'theme', 'locale', 'uiSession', 'layout', 'sessions', 'uiWorkspace', 'contextMenus'],
      apply(ctx) {
        install(ctx)
        ctx.provide('figProfile', profile)
        ctx.provide('figWorkspacePicker', pickerSections)
        ctx.provide('figTeamFileActions', fileActions.service)
        ctx.inject(['workspaces', 'conversation'], scope => {
          scope.provide('figTeamSessions', teamSessions(scope, profile))
        })
        ctx.inject(['remote', 'remote.workspaceFiles'], scope => {
          scope.effect(() => installTeamFileActions(scope, profile, fileActions))
        })
        ctx.effect(() => installWorkspacePicker(ctx, react, primitives, pickerSections))
        ctx.effect(() => applyPins(ctx, profile))
        ctx.effect(() => { const fold = foldPlugins(ctx, profile); pluginsPanel.attach(fold); return () => { pluginsPanel.attach(undefined); fold.dispose() } })
        ctx.effect(() => lockRequired(profile))
        ctx.effect(() => installEdition(ctx, react, primitives, profile, openSettings))
        ctx.effect(() => installTeamModels(ctx, profile))
        ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register(
          { name: 'sidebar.panellist.actions', id: 'fig-panel-pins', order: -10 }, PanelRows
        ))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'fig-required-plugins', order: 90 }, RequiredNotice
        ))
        ctx.effect(() => installBrand(ctx, profile))
        ctx.effect(() => installRailToggle())
        ctx.effect(() => installSidebarIcons())
        ctx.effect(() => installPageNavigation(ctx))
        ctx.effect(() => installTranscript())
        ctx.effect(() => installProcessDefault(ctx))
        ctx.effect(() => installSettingsGroups(ctx, profile))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'fig-runtime', order: -7, label: () => t('main.runtime')
        }, RuntimeSection))
        ctx.slots.inject('conversation.session.header.views.actions', () => ctx.slots.register(
          { name: 'conversation.session.header.views.actions', id: 'fig-session-actions', order: 100 }, SessionActionRows(ctx)
        ))
        ctx.slots.inject('settings.header', () => ctx.slots.register(
          { name: 'settings.header', priority: -100 }, SettingsHeader
        ))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'fig-sidebar-settings', order: 100, locale: 'settings' },
          ({ t }) => h(SidebarSettings, { ctx, t })
        ))
        ctx.slots.inject('plugins.tab', () => ctx.slots.register({
          name: 'plugins.tab', id: 'fig-custom-plugins', order: 100, label: () => t('main.customPlugins')
        }, props => h(CustomPlugins, { ...props, ctx })))
        // 「协作版插件」 to its right, team Profiles only.
        ctx.effect(() => {
          let active = true, dispose
          void profile.ready.then(value => {
            if (!active || value?.edition !== 'team') return
            const TeamPlugins = teamPluginsTab(react, { Switch }, profile)
            dispose = ctx.slots.inject('plugins.tab', () => ctx.slots.register({
              name: 'plugins.tab', id: 'fig-team-plugins', order: 110, label: () => t('main.teamPlugins')
            }, () => h(TeamPlugins)))
          })
          return () => { active = false; dispose?.() }
        })
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = customPluginsCss + teamPluginsCss
          document.head.append(style)
          return () => style.remove()
        })
        ctx.effect(() => extendMoreMenu(ctx))
        ctx.effect(() => limitLanguageMenu(ctx))
        ctx.effect(() => remindOverlaps(ctx))
        ctx.effect(() => {
          globalThis[filePathAtGlobal] = filePathAt
          return () => { delete globalThis[filePathAtGlobal] }
        })
        ctx.effect(() => {
          const open = () => openSettings(ctx)
          window.addEventListener(openSettingsEvent, open)
          return () => window.removeEventListener(openSettingsEvent, open)
        })
      }
    }
  }
})

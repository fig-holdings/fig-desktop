// Page half. Uses only Fig's public services (figUi, figActivity, figWorkspacePicker) and DSH's documented slots, and keeps
// working without them, as a team plugin must in DSH Web without Fig's shell.
window.__ModuleLoader__.load({
  id: '@fig-sample/team-console',
  factory(require) {
    const react = require('react')
    const h = react.createElement
    const panel = 'sample-team-market'
    function MarketIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': true }, h('path', { d: 'M3 7h14l-1 9H4L3 7Zm3 0V5a4 4 0 0 1 8 0v2' }))
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        window.__figSample = { figUi: false, figActivity: false }
        ctx.inject(['figTeamFileActions'], scope => {
          scope.effect(() => scope.figTeamFileActions.registerUpload(selection => { window.__figSample.upload = selection }))
          window.__figSample.fileActions = scope.figTeamFileActions.version
        })
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel }, () => h('main', { 'data-sample-market': '', style: { padding: 32 } }, 'Sample market')))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panel, order: 10, label: () => 'Sample market' }, MarketIcon))
        // A role switch: a manager gets the team admin panel and, in Task activity, the
        // manage block; __figSample.setManager(false) withdraws both, as a team plugin does when the role changes.
        const admin = 'sample-team-admin'
        let withdrawPanel
        const managerPanel = on => {
          withdrawPanel?.(); withdrawPanel = undefined
          if (!on) return
          const main = ctx.slots.register({ name: 'main', key: admin }, () => h('main', { 'data-sample-admin': '', style: { padding: 32 } }, 'Team admin'))
          const entry = ctx.slots.register({ name: 'sidebar.panellist', id: admin, order: 11, label: () => 'Team admin' }, MarketIcon)
          withdrawPanel = () => { entry(); main() }
        }
        ctx.slots.inject('sidebar.panellist', () => { managerPanel(true); window.__figSample.setManagerPanel = managerPanel; return () => managerPanel(false) })
        // A team settings section: Fig lists `cowork-` ids last under 协作版.
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'cowork-sample', order: -50, label: () => 'Sample team' }, () => h('p', { 'data-sample-settings': '' }, 'Sample team settings')))
        // Claimed tasks in the new session's workspace picker (figWorkspacePicker). A real team plugin maps each task's
        // project to its local workspace from Cowork's data; the test sets it through __figSample.setWorkspace.
        ctx.inject(['figWorkspacePicker'], scope => {
          const items = workspaceId => [
            { id: 'item-12', label: '#12 Sample task', detail: 'Sample project', workspaceId, draft: 'Task #12: Sample task\nAcceptance: the sample passes.' },
            { id: 'item-15', label: '#15 Cloud task', detail: '云端执行', disabled: true }
          ]
          const section = scope.figWorkspacePicker.register({ id: 'sample-claims', title: '我认领的任务', items: items(undefined),
            onPicked: (item, bound) => { window.__figSample.picked = { item: item.id, ...bound }; section.update({ selectedItemId: item.id }) } })
          window.__figSample.setWorkspace = id => section.update({ items: items(id) })
          scope.effect(() => () => section.dispose())
        })
        ctx.inject(['figUi', 'figActivity'], scope => {
          window.__figSample.figUi = scope.figUi.version
          window.__figSample.figActivity = scope.figActivity.version
          const { Card, StatusTag } = scope.figUi
          const handles = [
            scope.figActivity.register({ kind: 'view', id: 'default', label: 'Mine' }),
            scope.figActivity.register({ kind: 'view', id: 'sample-team', label: 'Team', component: () => h(Card, { 'data-sample-team-view': '', style: { padding: 16 } }, 'Team board') }),
            scope.figActivity.register({ kind: 'summary', id: 'sample-items', label: 'Work items', value: 3, caption: 'Claimed by you' }),
            scope.figActivity.register({ kind: 'attention', id: 'sample-items', count: 2, label: 'work items' }),
            scope.figActivity.register({ kind: 'section', id: 'sample-top', placement: 'top', title: 'My execution', component: ({ project }) => h(Card, { 'data-sample-top': project, style: { padding: 12 } }, h(StatusTag, { tone: 'accent' }, 'Claim #12')) }),
            scope.figActivity.register({ kind: 'section', id: 'sample-bottom', placement: 'bottom', title: 'Team to-do', component: () => h('p', { 'data-sample-bottom': '' }, 'Nothing pending') }),
            scope.figActivity.register({ kind: 'projects', id: 'sample-projects', projects: [{ id: 'team-project-1', name: 'Team project' }] })
          ]
          let manage = scope.figActivity.register({ kind: 'section', id: 'sample-manage', placement: 'bottom', order: 10, title: 'Manage', component: () => h('p', { 'data-sample-manage': '' }, 'Manager board'), open: true })
          window.__figSample.setManager = on => {
            manage?.dispose(); manage = undefined
            if (on) manage = scope.figActivity.register({ kind: 'section', id: 'sample-manage', placement: 'bottom', order: 10, title: 'Manage', component: () => h('p', { 'data-sample-manage': '' }, 'Manager board'), open: true })
            window.__figSample.setManagerPanel?.(on)
          }
          window.__figSample.sessions = scope.figActivity.sessions.get().length
          // A control at the heading's right end: a bell with an unread count.
          const bell = () => scope.figActivity.register({ kind: 'tool', id: 'sample-bell', component: () =>
            h('button', { type: 'button', 'data-sample-bell': '', 'aria-label': 'Notifications, 3 unread', style: { height: 36, padding: '0 12px', borderRadius: 999, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '🔔 3') })
          let bellHandle = bell()
          window.__figSample.setBell = on => { bellHandle?.dispose(); bellHandle = on ? bell() : undefined }
          scope.effect(() => () => { for (const handle of handles) handle.dispose(); manage?.dispose(); bellHandle?.dispose() })
        })
      }
    }
  }
})

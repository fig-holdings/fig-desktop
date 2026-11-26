import { install } from './client-locale.js'
import { developmentWorkbench } from './client-workbench.js'

// 研发工作台's page half: the Session-header button and the docked card or popover it places.
window.__ModuleLoader__.load({
  id: '@local/dsh-development-workbench',
  factory(require) {
    const workbench = developmentWorkbench(require('react'), require('react-dom')?.createPortal)
    return {
      inject: ['slots', 'sessions', 'sidebarRight', 'locale'],
      apply(ctx) { install(ctx); workbench.register(ctx) }
    }
  }
})

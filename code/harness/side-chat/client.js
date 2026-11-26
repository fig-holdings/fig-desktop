import { install } from './client-locale.js'
import { sideChat } from './client-side-chat.js'

// Side chat's page half: the right sidebar tab, its 开始 card and ⌥⌘S, and the send-to-main button under replies.
window.__ModuleLoader__.load({
  id: '@local/dsh-side-chat',
  factory(require) {
    // The send box is a body-level dialog: a reply's action row clips anything taller than its icons.
    const sideChats = sideChat(require('react'), require('react-dom')?.createPortal)
    return {
      inject: ['slots', 'sessions', 'uiWorkspace', 'sidebarRight', 'locale'],
      apply(ctx) { install(ctx); sideChats.register(ctx) }
    }
  }
})

import { installAttentionHooks } from './client-attention-hooks.js'

// The page half of Fig Desktop's shell channel: the globals main calls to hold back a notification for the open
// conversation and to open the session a clicked notification names.
window.__ModuleLoader__.load({
  id: '@local/dsh-shell-bridge',
  /** @param {(id: string) => any} loadModule */
  factory(loadModule) {
    return {
      inject: ['uiWorkspace', 'layout'],
      apply(ctx) {
        ctx.effect(() => installAttentionHooks(ctx))
        // rc.5 memoizes the picker for the lifetime of the connection. Re-read on opening
        // after a minute; the Host still owns the TTL and credentials of each route.
        ctx.inject(['modelDirectories'], scope => scope.effect(() => {
          const proto = loadModule('@deepseek-ai/dsh-client-ui-model-selection')?.ModelDirectory?.prototype
          if (typeof proto?.load !== 'function') return
          const original = proto.load
          let nextRead = 0
          /** @this {any} */
          function load(...args) {
            if (Date.now() >= nextRead && typeof this.catalog?.refresh === 'function') {
              nextRead = Date.now() + 60_000
              this.catalog.refresh()
            }
            return original.apply(this, args)
          }
          proto.load = load
          return () => { if (proto.load === load) proto.load = original }
        }))
      }
    }
  }
})

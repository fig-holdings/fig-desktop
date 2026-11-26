import { install } from './client-locale.js'
import {figUi, installStyle} from './components.js'

// Offers Fig's shared page pieces as the `figUi` service (components.js). Fig's panels and team plugins inject it;
// a plugin that may also run where Fig's packages are absent reads it with ctx.get('figUi') and falls back.
window.__ModuleLoader__.load({
  id: '@local/dsh-ui-kit',
  factory(require) {
    const service = figUi(require('react'))
    return {
      inject: ['locale'],
      apply(ctx) {
        install(ctx)
        ctx.effect(() => installStyle())
        ctx.provide('figUi', service)
      }
    }
  }
})

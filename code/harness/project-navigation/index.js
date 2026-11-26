import { join } from 'node:path'
import { dshHome } from '../shared/dsh-plugin.js'
import { pageRoute, registerPageRoute } from '../shared/http.js'
import { appearanceStore } from './store.js'
export const name = 'fig-project-navigation'
export function apply(ctx) {
  const store = appearanceStore(join(dshHome(), 'fig', 'project-appearance.json'))
  registerPageRoute(ctx, '/fig-project-navigation', 'project appearance', pageRoute({
    prefix: '/fig-project-navigation',
    endpoints: { list: () => store.list(), set: payload => store.set(payload?.workspaceId, payload?.appearance) },
    failure: () => ({ code: 'APPEARANCE_UNAVAILABLE', message: 'Project appearance could not be saved or loaded.' })
  }))
}

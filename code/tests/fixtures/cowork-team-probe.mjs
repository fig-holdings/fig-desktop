import { pageRoute, registerPageRoute } from '../../harness/shared/http.js'

export function apply(ctx) {
  ctx.inject(['shellCapabilities'], scope => {
    registerPageRoute(scope, '/cowork-team-probe', 'Cowork test probe', pageRoute({
      prefix: '/cowork-team-probe', endpoints: {
        async roundTrip() {
          const team = scope.shellCapabilities.coworkTeam
          if (!team) return false
          const path = '/api/team/fig-smoke?proof=1'
          const { headers, origin } = await team.authorize({ method: 'GET', path })
          const response = await fetch(new URL(path, origin), { headers, redirect: 'error' })
          return response.ok && typeof scope.shellCapabilities.openCachedFile === 'function'
        }
      }
    }))
  })
}

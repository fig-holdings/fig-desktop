import { join } from 'node:path'
import { historyStore, textLimit } from './history.js'
import { nextStepService } from './next-step.js'
import { dshHome } from '../shared/dsh-plugin.js'
import { pageRoute, registerPageRoute, RouteError } from '../shared/http.js'

// The composer's Host half: input history per workspace and the next-step hint, both stored under the DSH home.

export const name = 'fig-composer'
export const inject = ['llm']
const prefix = '/fig-composer'
const scoped = payload => {
  if (typeof payload?.scope !== 'string' || payload.scope === '') throw new RouteError(400, 'BAD_REQUEST')
  return payload.scope
}
const sessionOf = payload => {
  if (typeof payload?.sessionId !== 'string' || payload.sessionId === '') throw new RouteError(400, 'BAD_REQUEST')
  return payload.sessionId
}

export function apply(ctx) {
  const home = dshHome()
  const services = {
    history: historyStore(join(home, 'fig', 'input-history.json')),
    nextStep: nextStepService({ llm: ctx.llm, path: join(home, 'fig', 'next-step.json') })
  }
  ctx.on('session/event', (session, event) => services.nextStep.track(session, event))
  registerPageRoute(ctx, prefix, 'fig-composer: route', (connection, req, res) => route(connection, req, res, services))
}

/** POST /fig-composer/<endpoint> for the page plugin; services are `{ history, nextStep }`. */
export const route = pageRoute({
  prefix,
  bodyLimit: textLimit * 4 + 1024,
  endpoints: {
    'history/list': (payload, { history }) => history.list(scoped(payload)),
    'history/add': (payload, { history }) => history.add(scoped(payload), payload.text),
    'next-step/get': (payload, { nextStep }) => nextStep.next(sessionOf(payload)),
    'next-step/settings': (_payload, { nextStep }) => nextStep.settings(),
    'next-step/enable': (payload, { nextStep }) => nextStep.enable(payload?.enabled)
  },
  failure: (_error, endpoint) => ({ code: endpoint.split('/')[0].toUpperCase() })
})

import { rulesInfo } from './rules.js'
import { pageRoute, registerPageRoute } from '../shared/http.js'

// Effective rule sources: which AGENTS.md files the open session's current turn uses, and whether they changed since.
// Config: `startupDirectory`, the folder parent rules are read from down to the project's Git root (none: no parent rules).

export const name = 'fig-rule-sources'
export const inject = ['agents', 'workingDirectory']
const prefix = '/fig-rule-sources'

/** @param {any} ctx @param {{ startupDirectory?: string }} [config] */
export function apply(ctx, config = {}) {
  const startup = typeof config?.startupDirectory === 'string' ? config.startupDirectory : undefined
  registerPageRoute(ctx, prefix, 'fig-rule-sources: route', (connection, req, res) => route(connection, req, res, { rules: sessionId => rulesInfo(ctx, sessionId, startup) }))
}

/** POST /fig-rule-sources/info for the page plugin. */
export const route = pageRoute({
  prefix,
  endpoints: { 'info': (payload, { rules }) => rules(payload?.sessionId) },
  failure: () => ({ code: 'RULES' })
})

/** Start a fresh native conversation for a team task and return the identity the caller can bind. */
export function teamSessions(ctx, profile) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  return Object.freeze({
    version: 1,
    /** @param {{ prompt?: string }} input */
    async startDraft({ prompt } = {}) {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('figTeamSessions.startDraft requires a prompt')
      if ((await profile.ready)?.edition !== 'team') throw new Error('figTeamSessions requires a team Profile')

      const signal = AbortSignal.any([lifetime.signal, ctx.layout.beginNavigation()])
      const workspace = await ctx.workspaces.initializeDefault(signal)
      signal.throwIfAborted()
      const workspaceId = workspace?.workspaceId
      // A Profile without a default Workspace can still create an ungrouped Session in the Host's default directory.
      // Omitting sessionId makes DSH create anew, even when another task still has an unsent draft.
      const sessionId = await ctx.sessions.create(workspaceId === undefined ? {} : { workspaceId })
      signal.throwIfAborted()
      return ctx.sessions.using(sessionId, { source: 'mainView', signal }, () => {
        signal.throwIfAborted()
        const binding = ctx.sessions.binding(sessionId)
        if (!binding || ctx.conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'replace' }) !== 'applied')
          throw new Error('figTeamSessions could not initialize the draft')
        ctx.uiWorkspace.openSession(sessionId)
        return { sessionId, workspaceId }
      })
    }
  })
}

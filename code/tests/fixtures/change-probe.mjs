// Explicit no-model synthetic attribution fixture. Uses public WorkspaceChanges only.
import {pageRoute, registerPageRoute} from '../../harness/shared/http.js'
export function apply(ctx) {
  const events = new Map()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'workspace/changes') return
    events.set(session.id, [...events.get(session.id) ?? [], {seq: event.seq, turn: event.data.turn}].slice(-30))
  })
  registerPageRoute(ctx, '/change-probe', 'synthetic attribution', pageRoute({prefix: '/change-probe', failure: () => ({code: 'CHANGE_PROBE'}), endpoints: {
    events: ({id}) => events.get(id) ?? [],
    async read({id, seq}) {
      const service = ctx.get('workspaceChanges'), summary = service.summary(id, seq)
      return {api: Object.keys(service), summary: summary ?? null, diffs: summary ? await Promise.all(summary.files.map((_, index) => service.diff(id, seq, index, AbortSignal.timeout(15000)))) : []}
    }
  }}))
}

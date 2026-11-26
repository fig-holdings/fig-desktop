// Explicitly mounted isolated offline adapter. Each HTTP advance releases one native model step.
import { randomUUID } from 'node:crypto'
import { fromDsh } from '../../harness/shared/dsh-plugin.js'
import { pageRoute, registerPageRoute } from '../../harness/shared/http.js'
export const inject = ['llm']
export async function apply(ctx) {
  const { LlmAdapter } = await fromDsh('@deepseek-ai/dsh-llm')
  const queue = []
  let wake
  const model = { id: 'offline', name: 'Offline process probe', contextWindow: 32768 }
  class Adapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: model.name } }
    async listModels() { return [model] }
    async resolveModel(provider, id) { return { ...model, provider, id } }
    async *stream({ signal }) {
      if (!queue.length) await new Promise((resolve, reject) => {
        const abort = () => { wake = undefined; reject(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
        wake = () => { signal.removeEventListener('abort', abort); wake = undefined; resolve() }
        if (signal.aborted) abort()
      })
      signal.throwIfAborted()
      const step = queue.shift()
      if (step?.name) {
        const id = randomUUID(), args = JSON.stringify(step.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'OFFLINE PROCESS COMPLETE' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OFFLINE PROCESS COMPLETE' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['synthetic-process'], new Adapter()))
  registerPageRoute(ctx, '/task-process-probe', 'offline process probe', pageRoute({ prefix: '/task-process-probe', failure: error => ({ code: 'PROBE', message: String(error) }), endpoints: {
    advance(step) { queue.push(step); wake?.(); return true }
  } }))
}

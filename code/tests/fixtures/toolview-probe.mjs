// Test-only offline model for the tool view smoke: each queued step makes the next model call ask for one tool, so the
// native turn records a real tool/call and tool/result; with nothing queued it answers in text. No network, no credentials.
import { randomUUID } from 'node:crypto'
import { fromDsh } from '../../harness/shared/dsh-plugin.js'
import { pageRoute, registerPageRoute } from '../../harness/shared/http.js'

export const inject = ['llm']
export async function apply(ctx) {
  const { LlmAdapter } = await fromDsh('@deepseek-ai/dsh-llm')
  const queue = []
  const modelInfo = { id: 'offline', name: 'Synthetic offline', contextWindow: 32768, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }
  class Adapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Synthetic offline tool views' } }
    async listModels() { return [modelInfo] }
    async resolveModel(provider, id) { return { ...modelInfo, provider, id } }
    async *stream({ signal }) {
      signal.throwIfAborted()
      const step = queue.shift()
      if (step) {
        const id = 'call-' + randomUUID(), args = JSON.stringify(step.args ?? {})
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'SYNTHETIC-OK' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SYNTHETIC-OK' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const dispose = ctx.llm.registerAdapter(['synthetic-toolview'], new Adapter())
  ctx.effect(() => dispose)
  registerPageRoute(ctx, '/toolview-probe', 'synthetic tool views', pageRoute({ prefix: '/toolview-probe', failure: error => ({ code: 'TOOLVIEW_PROBE', message: String(error.message) }), endpoints: {
    queue({ name, args }) { queue.push({ name, args }); return queue.length }
  } }))
}

// Explicitly isolated deterministic adapter: real native turns/rendering, no network/model credentials.
import {fromDsh} from '../../harness/shared/dsh-plugin.js'
import {pageRoute, registerPageRoute} from '../../harness/shared/http.js'
export const inject = ['llm','agents','approval']
export async function apply(ctx) {
  const {LlmAdapter} = await fromDsh('@deepseek-ai/dsh-llm')
  let response = 'SYNTHETIC-RESULT', failure, suggestion = '', suggestPrompt = ''
  const clock = Date.now
  const modelInfo = {id:'offline', name:'Synthetic offline', contextWindow:32768,
    reasoning: { efforts: [{ id: 'high', name: 'High' }] }}
  class Adapter extends LlmAdapter {
    providerInfo(provider) {return {id: provider, name: 'Synthetic offline activity'}}
    async listModels() {return [modelInfo]}
    async resolveModel(provider, id) {return { ...modelInfo, provider, id }}
    async *stream({signal, messages}) {
      signal.throwIfAborted()
      // composer's next-step call (composer/next-step.js) gets the configured suggestion instead of the reply.
      const ask = messages?.find(message => message.id === 'fig-next-step')
      if (ask) {
        suggestPrompt = ask.content?.[0]?.text ?? ''
        yield {type:'block-start',index:0,blockType:'text'}
        yield {type:'text-delta',index:0,text:suggestion}
        yield {type:'block-end',index:0,block:{type:'text',text:suggestion}}
        yield {type:'finish',reason:{kind:'stop'}}
        return
      }
      if (failure) {yield {type:'finish',reason:{kind:'error',failure}}; return}
      yield {type:'block-start',index:0,blockType:'text'}
      yield {type:'text-delta',index:0,text:response}
      yield {type:'block-end',index:0,block:{type:'text',text:response}}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  const dispose = ctx.llm.registerAdapter(['synthetic-activity'],new Adapter())
  ctx.effect(() => dispose)
  ctx.effect(() => () => {Date.now = clock})
  registerPageRoute(ctx,'/activity-probe','synthetic activity',pageRoute({prefix:'/activity-probe', failure: e => ({code:'ACTIVITY_PROBE',message:String(e.message)}), endpoints:{
    configure({text, suggest, fail = false, code = 'SYNTHETIC_FAILURE', status}) {
      response = text ?? 'SYNTHETIC-RESULT'
      if (suggest !== undefined) suggestion = suggest
      failure = fail ? {code, ...(status === undefined ? {} : {status}), message: 'Synthetic blocked task. No external action.'} : undefined
      return true
    },
    suggestPrompt() {return suggestPrompt},
    clock({offset = 0}) {Date.now = () => clock() + offset; return Date.now()},
    async archive({id}) {await ctx.get('workspaceRegistry').archiveSession(id);return true}
  }}))
}

// Synthetic wire responses in the isolated search smoke test. No vendor request goes outside.
import assert from 'node:assert/strict'
export function apply(ctx) {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const dest = new URL(typeof url === 'string' || url instanceof URL ? url : url.url)
    const headers = new Headers(options?.headers)
    if (dest.pathname.endsWith('/models')) {
      return Response.json({ data: [{ id: 'grok-4.7' }, { id: 'gpt-6.1-sol' }] })
    }
    const source = { url: 'https://example.org' + dest.pathname, title: dest.hostname }
    if (dest.hostname === 'api.search.brave.com') {
      assert.equal(headers.get('x-subscription-token'), 'fig-synthetic-brave-key')
      assert.equal(headers.get('authorization'), null)
      return Response.json({ web: { results: [source] } })
    }
    if (dest.pathname.endsWith('/messages')) {
      assert.equal(dest.origin, 'http://127.0.0.1:1')
      assert.equal(headers.get('x-api-key'), 'fig-smoke-catalog-only')
      assert.equal(JSON.parse(options.body).model, 'deepseek-flash')
      return Response.json({ content: [{ type: 'web_search_tool_result', content: [{ ...source, type: 'web_search_result' }] }] })
    }
    if (dest.pathname.endsWith('/responses')) {
      const expected = {
        'cli-chat-proxy.grok.com': ['grok-4.7', 'fig-synthetic-grok-access-token'],
        'api.openai.com': ['gpt-6.1-sol', 'fig-synthetic-chatgpt-token'],
        'custom.example': ['personal-model', 'fig-synthetic-personal-key']
      }[dest.hostname]
      assert.ok(expected)
      assert.equal(headers.get('authorization'), 'Bearer ' + expected[1])
      if (dest.hostname === 'cli-chat-proxy.grok.com') assert.equal(headers.get('x-grok-client-version'), '1.2.3')
      const body = JSON.parse(options.body)
      assert.equal(body.model, expected[0])
      assert.equal(body.input[0].content[0].type, 'input_text')
      assert.deepEqual(body.tools, [{ type: 'web_search' }])
      assert.ok(!Object.hasOwn(body, 'tool_choice'))
      const item = { type: 'web_search_call', action: { sources: [source] }, status: 'completed' }
      const events = [{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { output: [] } }]
      const wire = events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('')
      // The ChatGPT subscription gateway has returned streams without a Content-Type header.
      return dest.hostname === 'api.openai.com' ? new Response(new TextEncoder().encode(wire))
        : new Response(wire, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (dest.hostname === '127.0.0.1') return previous(url, options)
    throw Error('Unexpected external request in isolated fixture')
  }
  ctx.on('dispose', () => { globalThis.fetch = previous })
}

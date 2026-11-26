// Redirect only the four vendor routes and public model cards to the isolated test server.
export function apply(ctx) {
  const previous = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return previous(input, init)
    if (!['api.openai.com', 'developers.openai.com', 'cli-chat-proxy.grok.com', 'api.x.ai'].includes(url.hostname)) {
      throw new Error('Unexpected external request in model discovery fixture')
    }
    const original = new Request(input, init)
    return previous(process.env.FIG_MODEL_TEST_SERVER + '/' + url.hostname + url.pathname, {
      headers: original.headers, method: original.method, body: original.body, duplex: 'half', signal: original.signal
    })
  }
  ctx.on('dispose', () => { globalThis.fetch = previous })
}

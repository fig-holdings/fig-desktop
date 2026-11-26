// Explicit isolated account UI fixture. No model or quota service may leave loopback.
export function apply(ctx) {
  ctx.effect(() => {
    const previous = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return Promise.reject(new Error('Synthetic account fixture denies external network'))
      return previous(input, init)
    }
    return () => { globalThis.fetch = previous }
  })
}

// Host half: reads the optional shell capabilities and serves them to the page, as a team plugin would.
export const name = 'sample-team-console'
export function apply(ctx) {
  const capabilities = ctx.get?.('shellCapabilities')
  globalThis.__figSampleCapabilities = {
    profile: capabilities?.profile ?? null,
    openExternal: typeof capabilities?.openExternal === 'function'
  }
}

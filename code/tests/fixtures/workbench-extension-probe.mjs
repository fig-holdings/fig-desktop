import { pageRoute, registerPageRoute } from '../../harness/shared/http.js'

export function apply(ctx) {
  registerPageRoute(ctx, '/workbench-extension-probe', 'workbench extension fixture', pageRoute({
    prefix: '/workbench-extension-probe', endpoints: {
      state: () => globalThis[Symbol.for('fig.workbench.test')]?.state,
      scenario: ({ name }) => { globalThis[Symbol.for('fig.workbench.test')]?.scenario(name); return true },
      invalidate: () => { globalThis[Symbol.for('fig.workbench.test')]?.invalidate(); return true },
      stop: () => { globalThis[Symbol.for('fig.workbench.test')]?.dispose(); return true },
      async untrusted() {
        try {
          await ctx.get('figDevelopment').register({ version: 1, provider: { owns() {} }, sessionPolicy() {}, pullPolicy() {} })
          return false
        } catch { return true }
      }
    }
  }))
}

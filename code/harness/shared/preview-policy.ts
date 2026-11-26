export type PreviewStep = {action: 'click' | 'fill' | 'press' | 'waitFor'; selector: string; text?: string; key?: string; state?: 'visible' | 'hidden' | 'attached' | 'detached'}
export const previewKeys = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
/** Every step but a wait acts on the page. */
const mutatingStep = (step: any): boolean => step?.action !== 'waitFor'
/** For a raw, possibly invalid call: whether it asks for page actions. */
export const mutatesPreview = (args: any): boolean => Array.isArray(args?.steps) && args.steps.some(mutatingStep)

// Local addresses. Each caller keeps its own rule (tests/local-address.test.mjs lists them).
const loopbackNames = ['localhost', '127.0.0.1', '[::1]']
/** Exactly localhost, 127.0.0.1 or [::1]. */
export const loopbackHost = (url: URL): boolean => loopbackNames.includes(url.hostname)
/** A loopback host or a *.localhost name, on any scheme. */
export const localHost = (url: URL): boolean => loopbackHost(url) || url.hostname.endsWith('.localhost')
export const hasCredentials = (url: URL): boolean => Boolean(url.username || url.password)
/** A resource the screenshot loads without leaving this machine: a local scheme, or a local host. */
export const capturedLocally = (url: URL): boolean => ['file:', 'data:', 'blob:', 'about:'].includes(url.protocol) || localHost(url)
/** An interactive capture's target: a file, or http(s) on an exact loopback host without credentials. */
export const interactiveTarget = (url: URL): boolean =>
  url.protocol === 'file:' || (['http:', 'https:'].includes(url.protocol) && loopbackHost(url) && !hasCredentials(url))
const secret = (text: string) => /\b(?:sk-[\w-]{16,}|xai-[\w-]{16,}|Bearer\s+\S{12,})/i.test(text)
/** Validate the complete call before target loading, approval or any action. */
export function previewStepPlan(args: any): {steps: PreviewStep[]; widths: number[]; mutating: boolean} | undefined {
  if (args.steps === undefined) return undefined
  if (!Array.isArray(args.steps)) throw new Error('steps must be an array')
  if (!args.steps.length) return undefined
  if (args.steps.length > 10 || Buffer.byteLength(JSON.stringify(args)) > 32768) throw new Error('Preview steps exceed the 10-step / 32KiB bound')
  if (args.widths !== undefined && (!Array.isArray(args.widths) || args.widths.length > 1 || args.widths.some((w: number) => !Number.isInteger(w) || w < 320 || w > 2560))) throw new Error('Interactive preview requires exactly one valid viewport')
  const steps = args.steps.map((step: any) => {
    if (!step || !['click','fill','press','waitFor'].includes(step.action) || typeof step.selector !== 'string' || !step.selector || step.selector.length > 512) throw new Error('Invalid bounded preview step')
    const allowed = {click: ['action','selector'], fill: ['action','selector','text'], press: ['action','selector','key'], waitFor: ['action','selector','state']}[step.action as PreviewStep['action']]
    if (Object.keys(step).some(key => !allowed.includes(key))) throw new Error('Unsupported preview step field')
    if (step.action === 'fill' && (typeof step.text !== 'string' || step.text.length > 4096 || secret(step.text))) throw new Error('Fill requires bounded non-secret text')
    if (secret(step.selector)) throw new Error('Secrets are not permitted in preview selectors')
    if (step.action === 'press' && !previewKeys.includes(step.key)) throw new Error('Unsupported preview key')
    if (step.action === 'waitFor' && step.state !== undefined && !['visible','hidden','attached','detached'].includes(step.state)) throw new Error('Invalid wait state')
    return {...step}
  })
  return {steps, widths: args.widths?.length ? args.widths : [1440], mutating: steps.some(mutatingStep)}
}
/** Known effective presets only; a matching name with different knobs is not equivalent. */
function stamp(ctx: any, session: any) {
  try { const name = ctx.permissionPresets.current(session); const spec = ctx.permissionPresets.resolve(name); return {name, sandbox: spec.sandbox, approval: spec.approval} } catch { return {name: 'unknown', sandbox: 'unknown', approval: 'unknown'} }
}
export async function authorizePreview(ctx: any, exec: any, plan: NonNullable<ReturnType<typeof previewStepPlan>>, target: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  if (!plan.mutating) return false
  const original = stamp(ctx, exec.agent.session)
  if (original.name === 'danger-full-access' && original.sandbox === 'danger-full-access') return true
  if (original.name !== 'workspace-write' || original.sandbox !== 'workspace-write') throw new Error('This permission preset permits observation only; preview actions were not run')
  if (original.approval === 'never') throw new Error('This preset disables approval for operations requiring it; preview actions were not run')
  // The native approval service enforces never/unavailable/cancelled; presentation kind is not permission.
  if (typeof ctx.approval?.request !== 'function') throw new Error('Native approval is unavailable; preview permits observation only')
  const decision = await ctx.approval.request({agent: exec.agent, toolName: 'preview', ...(exec.callId ? {callId: exec.callId} : {}), signal,
    reason: `Local preview actions at ${target}: ${plan.steps.map(step => step.action + '(' + step.selector + ')').join(', ')}`})
  signal.throwIfAborted()
  if (decision !== 'allowed-once') throw new Error('Preview actions were not approved; nothing was loaded or run')
  if (JSON.stringify(stamp(ctx, exec.agent.session)) !== JSON.stringify(original)) throw new Error('Permission changed while awaiting preview approval; actions were not run')
  return true
}

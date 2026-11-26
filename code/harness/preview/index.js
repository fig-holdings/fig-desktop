import { randomBytes } from 'node:crypto'
import { mkdir, readFile, stat, writeFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, relative, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { previewStepPlan, authorizePreview, mutatesPreview, hasCredentials, localHost, loopbackHost } from '../shared/preview-policy.ts'
import { dshHome, fromDsh, textBlock } from '../shared/dsh-plugin.js'
import { registerPageRoute } from '../shared/http.js'

// The `preview` tool for every DSH session and model: Fig opens a local page (a file in the workspace
// or a localhost address) in its own headless capture mode (app/main/capture.ts), at one or more
// widths, and returns what a model needs to check its user interface work without seeing it: load
// and console errors, failed and external requests, horizontal overflow with the elements causing
// it, where the first content starts, and boxes of chosen elements. Screenshots are saved under
// DSH_HOME/fig/preview/ for models that can open images with read_image.

// Permission services are optional read capabilities: missing services keep static/observation preview.
export const inject = ['tools', 'workingDirectory']

const toolName = 'preview'
const defaultWidths = [1440, 390]
const captureTimeout = 120_000
const blankTop = 120

/** The page to open: a local http(s) address, or a file resolved against the working directory. */
export async function previewTarget(target, cwd, confined = false) {
  const text = String(target ?? '').trim()
  if (!text) throw new Error('Give a file path or a localhost URL to preview.')
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text)
    if (hasCredentials(url) || (confined && (!loopbackHost(url) || [...url.searchParams.keys()].some(key => /token|password|secret|api.?key|authorization/i.test(key))))) throw new Error('Interactive preview requires a non-secret loopback target')
    if (!localHost(url)) throw new Error('preview opens only local pages: a workspace file or a localhost / 127.0.0.1 address.')
    return url.href
  }
  const path = text.startsWith('file://') ? fileURLToPath(text) : isAbsolute(text) ? text : resolve(cwd, text)
  const info = await stat(path).catch(() => undefined)
  if (!info) throw new Error(`No such file: ${path}`)
  const file = info.isDirectory() ? join(path, 'index.html') : path
  if (!(await stat(file).catch(() => undefined))?.isFile()) throw new Error(`No index.html in ${path}`)
  if (confined) {
    const root = await realpath(cwd), canonical = await realpath(file), rel = relative(root, canonical)
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Interactive file preview is confined to the current task directory')
    return pathToFileURL(canonical).href
  }
  return pathToFileURL(file).href
}

/** Requested widths, kept to 1–4 values between 320 and 2560 px. */
export function previewWidths(widths) {
  const list = [...new Set((Array.isArray(widths) ? widths : []).filter(width => Number.isInteger(width) && width >= 320 && width <= 2560))].slice(0, 4)
  return list.length ? list : defaultWidths
}

/** The capture result as text a model without image input can act on. */
export function previewText(target, theme, result) {
  const lines = [`Preview of ${target} (${theme} theme).`]
  if (result.title) lines.push(`Title: ${result.title}`)
  if (result.loadError) lines.push(`Load error: ${result.loadError}`)
  const list = (label, items) => lines.push(items.length ? `${label} (${items.length}):\n` + items.map(item => '- ' + item).join('\n') : `${label}: none`)
  list('Console errors', result.consoleErrors ?? [])
  list('Failed requests', result.failedRequests ?? [])
  lines.push(result.externalHosts?.length
    ? `External hosts requested (the page needs the network for these): ${result.externalHosts.join(', ')}`
    : 'External hosts requested: none (the page works offline)')
  for (const step of result.steps ?? []) lines.push(`Step ${step.index} ${step.action}: ${step.status}; ${step.elapsedMs}ms${step.observation ? '; ' + step.observation : ''}${step.error ? '; ' + step.error : ''}.`)
  if (result.steps?.some(step => step.status !== 'pass')) lines.push('Stopped: earlier actions may have taken effect. Inspect the result before retrying; do not automatically repeat this call.')
  if (result.finalUrl === null) lines.push('Final URL unavailable after the owned page was stopped.')
  if (result.finalUrl) lines.push('Final URL: ' + result.finalUrl)
  if (result.guardFailure) lines.push('Guard stopped preview: ' + result.guardFailure)
  for (const view of result.views ?? []) {
    if (view.error) { lines.push(`${view.width}px: could not capture (${view.error})`); continue }
    const parts = [`page height ${view.pageHeight}px`]
    if (view.contentTop !== undefined) parts.push(`first content at ${view.contentTop}px from the top` + (view.contentTop > blankTop ? ' (blank area above it)' : ''))
    parts.push(view.overflowX > 0 ? `HORIZONTAL OVERFLOW ${view.overflowX}px` : 'no horizontal overflow')
    lines.push(`${view.width}px: ${parts.join('; ')}.`)
    for (const item of view.overflowing ?? []) lines.push(`  past the right edge (to x=${item.right}): ${item.element}`)
    if (view.brokenImages?.length) lines.push(`  broken images: ${view.brokenImages.join(', ')}`)
    for (const entry of view.boxes ?? []) {
      lines.push(`  ${entry.selector}: ` + (entry.error ?? (entry.boxes.length
        ? entry.boxes.map(box => `${box.width}×${box.height} at (${box.x}, ${box.y})`).join('; ') : 'not found')))
    }
    if (view.screenshot) lines.push(`  screenshot: ${view.screenshot}`)
  }
  lines.push('These findings are complete as text. Only a model that accepts image input should open a screenshot with read_image; otherwise do not try.')
  return lines.join('\n')
}

/**
 * What the conversation row shows for one finished preview (the tool's `presentationMeta`): counts and, per width,
 * the overflow and the screenshot. `shot` names the screenshot for the page route below; `screenshot` is its path.
 */
export function previewMeta(value, home) {
  const root = join(home, 'fig', 'preview')
  return {
    kind: 'fig-preview', target: value.target, theme: value.theme, title: value.title ?? null, loadError: value.loadError ?? null,
    consoleErrors: value.consoleErrors?.length ?? 0, failedRequests: value.failedRequests?.length ?? 0,
    failedSteps: (value.steps ?? []).filter(step => step.status !== 'pass').length,
    views: (value.views ?? []).map(view => {
      const shot = view.screenshot ? relative(root, view.screenshot).split(sep).join('/') : null
      return { width: view.width, error: view.error ?? null, overflowX: view.overflowX ?? 0, brokenImages: view.brokenImages?.length ?? 0,
        screenshot: view.screenshot ?? null, shot: shot && shotName.test(shot) ? shot : null }
    })
  }
}

// `<run folder>/<width>-<theme>.png`, as preview() and the capture name them.
const shotName = /^[\w-]+\/\d+-(?:light|dark)\.png$/

/**
 * The page's read of one screenshot, for the row's thumbnails: POST `{ shot }` under `/fig-preview/shot`, answered
 * with the PNG. It passes DSH's connection check like Fig's other page routes and serves only preview's own files.
 */
export function shotRoute(home) {
  return async (connection, req, res) => {
    const end = status => { res.writeHead(status, { 'cache-control': 'no-store' }); res.end() }
    if (connection.requestRejection(req)) return end(403)
    if (req.method !== 'POST') return end(404)
    let body = ''
    req.setEncoding('utf8')
    for await (const chunk of req) { body += chunk; if (body.length > 1024) return end(413) }
    let shot
    try { shot = JSON.parse(body).shot } catch { return end(400) }
    if (typeof shot !== 'string' || !shotName.test(shot)) return end(400)
    const image = await readFile(join(home, 'fig', 'preview', shot)).catch(() => undefined)
    if (!image) return end(404)
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(image)
  }
}

/**
 * Opens the page through the shell's page capture (`renderPage`) and returns its diagnostics.
 * @param {{ target?: unknown, widths?: unknown, theme?: unknown, selectors?: unknown, steps?: unknown }} args
 * @param {string} cwd
 * @param {{ renderPage?: (jobPath: string, options: { signal: AbortSignal, logPath: string }) => Promise<void>, home: string, signal?: AbortSignal, authorized?: boolean, expectedTarget?: string }} options
 *   `signal` carries the caller's deadline (the tool's covers authorization too); without one the capture gets its own.
 */
export async function preview(args, cwd, { renderPage, home, signal, authorized = false, expectedTarget = undefined }) {
  if (typeof renderPage !== 'function') throw new Error('preview needs a page capture from the desktop shell; none is available here.')
  const plan = previewStepPlan(args)
  if (plan?.mutating && !authorized) throw new Error('Interactive preview requires native permission authorization')
  const target = await previewTarget(args.target, cwd, Boolean(plan))
  if (plan && expectedTarget && target !== expectedTarget) throw new Error('Preview target changed after authorization; actions were not run')
  const theme = args.theme === 'dark' ? 'dark' : 'light'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const output = join(home, 'fig', 'preview', `${stamp}-${randomBytes(3).toString('hex')}`)
  await mkdir(output, { recursive: true })
  const jobPath = join(output, 'job.json')
  const selectors = (Array.isArray(args.selectors) ? args.selectors : []).filter(item => typeof item === 'string').slice(0, 10)
  await writeFile(jobPath, JSON.stringify({url: target, widths: plan?.widths ?? previewWidths(args.widths), theme, selectors, output, ...(plan ? {steps: plan.steps, allowedRoot: await realpath(cwd), allowMutation: authorized} : {})}))
  await renderPage(jobPath, { signal: signal ?? AbortSignal.timeout(captureTimeout), logPath: join(output, 'capture.log') })
  const result = JSON.parse(await readFile(join(output, 'result.json'), 'utf8').catch(() => {
    throw new Error('The page capture wrote no result; see ' + join(output, 'capture.log'))
  }))
  return { target, theme, ...result, text: previewText(target, theme, result) }
}

/** The tool exists only where a shell lends a page capture: the optional `shellCapabilities.renderPage`
 * (Fig's shell-bridge). Without one nothing is registered. @param {any} ctx */
export function apply(ctx) {
  ctx.inject(['shellCapabilities'], scope => {
    const renderPage = scope.shellCapabilities?.renderPage
    if (typeof renderPage === 'function') registerPreview(ctx, scope, renderPage).catch(error => ctx.logger?.warn?.('fig-preview: the preview tool could not be registered: ' + (error?.message ?? error)))
  })
}

async function registerPreview(ctx, scope, renderPage) {
  const home = dshHome()
  registerPageRoute(ctx, '/fig-preview/shot', 'fig-preview screenshots', shotRoute(home))
  const { defineTool } = await fromDsh('@deepseek-ai/dsh-tools')
  scope.effect(() => ctx.tools.register(defineTool({
    name: toolName,
    description: 'Open a local web page the way a user would see it and report what is wrong with it. Use it after creating or '
      + 'changing an HTML page, CSS or any user interface, before saying the work is done. target is an HTML file (relative to '
      + 'the working directory, or absolute) or a localhost / 127.0.0.1 URL of a running dev server; public sites are not opened. '
      + 'Reports load and console errors, failed requests, external hosts the page needs (offline readiness), horizontal overflow '
      + 'at each width with the elements causing it, where the first content starts (a large value means blank space at the top), '
      + 'broken images, and the boxes of up to 10 CSS selectors. Checks 1440 px and 390 px wide unless widths are given. '
      + 'Saves a full-page screenshot per width; only a model that accepts image input should open it with read_image. Takes a few seconds.',
    parameters: {
      target: { type: 'string', required: true, description: 'HTML file path or localhost URL.' },
      widths: { type: 'array', items: { type: 'integer' }, description: 'Viewport widths in px, 320–2560, at most 4. Default [1440, 390].' },
      theme: { type: 'string', enum: ['light', 'dark'], description: 'Color scheme the page sees (prefers-color-scheme). Default light.' },
      steps: {
        type: 'array',
        description: 'Optional bounded local actions (max 10). Each has action click/fill/press/waitFor and selector; fill has text (max4096), '
          + 'press key Enter/Tab/Escape/ArrowUp/ArrowDown/ArrowLeft/ArrowRight, waitFor state visible/hidden/attached/detached. Exactly one viewport. '
          + 'Native permission/approval applies; no passwords, files, downloads, external origins or scripts.',
        items: { type: 'object', additionalProperties: false, properties: {
          action: { type: 'string', required: true, enum: ['click', 'fill', 'press', 'waitFor'] },
          selector: { type: 'string', required: true },
          text: { type: 'string' }, key: { type: 'string' }, state: { type: 'string' }
        } }
      },
      selectors: { type: 'array', items: { type: 'string' }, description: 'CSS selectors whose boxes to report, at most 10.' }
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [textBlock(value.text)],
      presentationMeta: (_args, value) => previewMeta(value, home)
    },
    timeoutMs: captureTimeout + 10_000,
    isConcurrencySafe: args => !mutatesPreview(args),
    async execute(args, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const plan = previewStepPlan(args)
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(captureTimeout)])
      // preview() resolves the target again and refuses one that changed after authorization.
      const target = await previewTarget(args.target, cwd, Boolean(plan))
      const authorized = plan ? await authorizePreview({permissionPresets: ctx.get('permissionPresets'), approval: ctx.get('approval')}, exec, plan, target, signal) : false
      return preview(args, cwd, {renderPage, home, signal, authorized, expectedTarget: target})
    },
    presentCall: args => ({ card: 'generic', title: 'Preview ' + String(args.target ?? ''), kind: mutatesPreview(args) ? 'write' : 'read' })
  })))
}

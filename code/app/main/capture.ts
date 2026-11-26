import { app, BrowserWindow, nativeTheme, session } from 'electron'
import { mkdtempSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { stepGuard, runSteps, bounded, type StepResult } from './capture-steps'
import { capturedLocally, previewStepPlan, type PreviewStep } from '../../harness/shared/preview-policy'
import { errorText } from '../../harness/shared/log'
import { join } from 'node:path'

// Fig's headless page capture for the `preview` tool (harness/preview). The DSH Host starts this
// app with `--fig-capture=<job.json>`: no window is shown, the page loads in a sandboxed, in-memory
// session at each requested width, and the diagnostics and screenshots go to the job's output folder.

export interface CaptureJob {
  url: string
  widths: number[]
  theme: 'light' | 'dark'
  selectors: string[]
  output: string
  steps?: PreviewStep[]
  allowedRoot?: string
  allowMutation?: boolean
}

export interface CaptureView {
  width: number
  screenshot?: string
  pageHeight?: number
  overflowX?: number
  overflowing?: { element: string, right: number }[]
  contentTop?: number
  brokenImages?: string[]
  boxes?: { selector: string, boxes?: { x: number, y: number, width: number, height: number }[], error?: string }[]
  error?: string
}

export interface CaptureResult {
  url: string
  title?: string
  loadError?: string
  consoleErrors: string[]
  failedRequests: string[]
  externalHosts: string[]
  views: CaptureView[]
  steps?: StepResult[]
  finalUrl?: string | null
  status?: 'pass' | 'stopped'
  guardFailure?: string
}

export const captureFlag = '--fig-capture='
const viewportHeight = 900
const maxCaptureHeight = 6000
const loadTimeout = 20_000
const listLimit = 20
/** Adds `item` to a diagnostic list once, up to listLimit entries. */
const pushLimited = (list: string[], item: string) => { if (list.length < listLimit && !list.includes(item)) list.push(item) }

// Runs in the page: layout facts a text-only model can act on.
function measure(selectors: string[]) {
  const describe = (element: Element) => {
    const id = element.id ? '#' + element.id : ''
    const classes = typeof element.className === 'string' && element.className.trim()
      ? '.' + element.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    return element.tagName.toLowerCase() + id + classes + (text ? ` "${text}"` : '')
  }
  const visible = (element: Element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
  }
  const width = document.documentElement.clientWidth
  const overflowX = document.documentElement.scrollWidth - width
  const elements = [...document.body.querySelectorAll('*')]
  // Content scrolled or clipped inside a container that fits does not widen the page.
  const contained = (element: Element) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX !== 'visible' && parent.getBoundingClientRect().right <= width + 1) return true
    }
    return false
  }
  // The outermost elements past the right edge, so one wide card is not reported with every child.
  const overflowing = overflowX > 0
    ? elements.filter(element => visible(element) && element.getBoundingClientRect().right > width + 1 && !contained(element) &&
      !(element.parentElement && element.parentElement !== document.body && element.parentElement.getBoundingClientRect().right > width + 1))
      .slice(0, 8).map(element => ({ element: describe(element), right: Math.round(element.getBoundingClientRect().right) }))
    : []
  // Where the first visible content starts: text, image or control on screen. An SVG holding only
  // symbol definitions (an icon sprite) draws nothing, so it does not count, though it takes space.
  const drawn = (element: Element) => element.tagName.toUpperCase() !== 'SVG' ||
    [...element.children].some(child => !['defs', 'symbol', 'style', 'title'].includes(child.tagName.toLowerCase()))
  const onScreen = (element: Element) => { const box = element.getBoundingClientRect(); return box.bottom + scrollY > 0 && box.right > 0 && box.left < width }
  const content = elements.filter(element => visible(element) && onScreen(element) && drawn(element) && (
    ['IMG', 'SVG', 'CANVAS', 'VIDEO', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT'].includes(element.tagName.toUpperCase()) ||
    [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim())))
  const contentTop = content.length ? Math.max(0, Math.round(Math.min(...content.map(element => element.getBoundingClientRect().top + scrollY)))) : undefined
  const brokenImages = [...document.images].filter(image => image.complete && image.naturalWidth === 0).slice(0, 10).map(image => image.currentSrc || image.src)
  const boxes = selectors.slice(0, 10).map(selector => {
    try {
      return { selector, boxes: [...document.querySelectorAll(selector)].slice(0, 5).map(element => {
        const box = element.getBoundingClientRect()
        return { x: Math.round(box.x), y: Math.round(box.y + scrollY), width: Math.round(box.width), height: Math.round(box.height) }
      }) }
    } catch { return { selector, error: 'invalid selector' } }
  })
  return { title: document.title, pageHeight: document.documentElement.scrollHeight, overflowX, overflowing, contentTop, brokenImages, boxes }
}

async function captureWidth(job: CaptureJob, width: number, partition: string, result: CaptureResult, signal?: AbortSignal): Promise<CaptureView> {
  const strict = Boolean(job.steps?.length)
  const window = new BrowserWindow({show: false, width, height: viewportHeight, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: {partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, disableDialogs: strict}})
  const page = window.webContents
  let guard: Awaited<ReturnType<typeof stepGuard>> | undefined
  const abort = () => {if (!window.isDestroyed()) window.destroy()}
  signal?.addEventListener('abort', abort, {once: true})
  if (signal?.aborted) abort()
  page.on('console-message', ({level, message}) => {if (level === 'error') pushLimited(result.consoleErrors, message.slice(0, 300))})
  try {
    if (strict) {
      // Materialize an inert renderer before enabling the debugger's chooser interception. No task
      // URL/resource is loaded until all guards are installed; awaiting Page.enable before a renderer
      // exists otherwise deadlocks Chromium's lazy target startup.
      await bounded(window.loadURL('about:blank'), 5000, signal)
      guard = await bounded(stepGuard(job, page, page.session, message => pushLimited(result.failedRequests, message)), 5000, signal)
    } else page.setWindowOpenHandler(() => ({action: 'deny'}))
    try {await bounded(window.loadURL(job.url), loadTimeout, signal)} catch (error) {result.loadError ??= errorText(error); if (strict) throw error}
    if (guard) {
      await guard.check()
      result.steps = await runSteps(job, page, guard, signal)
      result.guardFailure = guard.failure
      if (page.isDestroyed() || result.steps.some(step => step.status !== 'pass')) throw new Error(guard.failure ?? 'Steps stopped')
      await guard.check(); result.finalUrl = page.getURL()
    }
    await bounded(page.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true), strict ? 5000 : 20000, signal)
    await new Promise(resolve => setTimeout(resolve, 400))
    const facts = await page.executeJavaScript(`(${measure.toString()})(${JSON.stringify(job.selectors)})`, true)
    result.title ??= facts.title || undefined
    const height = Math.min(Math.max(facts.pageHeight, viewportHeight), maxCaptureHeight)
    if (!strict) window.setContentSize(width, height)
    await new Promise(resolve => setTimeout(resolve, 300))
    const image = await page.capturePage(), screenshot = join(job.output, `${width}-${job.theme}.png`)
    await writeFile(screenshot, image.toPNG())
    const {title: _title, ...view} = facts
    return {width, screenshot, ...view}
  } catch (error) {
    if (strict) {
      result.finalUrl = page.isDestroyed() ? null : page.getURL()
      result.guardFailure = guard?.failure ?? (signal?.aborted ? 'Preview cancelled' : 'Capture setup/load did not complete')
      result.steps ??= job.steps!.map((step, index) => ({index: index + 1, action: step.action, status: signal?.aborted ? 'cancelled' : 'skipped', elapsedMs: 0, error: 'Load or guard did not complete'}))
    }
    return {width, error: errorText(error)}
  } finally {
    signal?.removeEventListener('abort', abort); guard?.dispose()
    if (!window.isDestroyed()) window.destroy()
  }
}

export async function capture(job: CaptureJob, signal?: AbortSignal): Promise<CaptureResult> {
  const plan = previewStepPlan({steps: job.steps, widths: job.widths})
  const strict = Boolean(plan)
  if (plan?.mutating && job.allowMutation !== true) throw new Error('Interactive capture lacks native authorization')
  if (strict && typeof job.allowedRoot !== 'string') throw new Error('Interactive capture needs a confined root')
  const result: CaptureResult = { url: job.url, consoleErrors: [], failedRequests: [], externalHosts: [], views: [] }
  nativeTheme.themeSource = job.theme
  const partition = 'fig-capture-' + randomUUID()
  const pageSession = session.fromPartition(partition, { cache: false })
  if (strict) await pageSession.setProxy({mode: 'direct'})
  pageSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  if (!strict) pageSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url)
      if (!capturedLocally(url)) pushLimited(result.externalHosts, url.host)
    } catch { /* Unparseable URLs fail on their own. */ }
    callback({})
  })
  const failed = (entry: string) => pushLimited(result.failedRequests, entry)
  if (!strict) pageSession.webRequest.onCompleted(details => { if (details.statusCode >= 400) failed(`${details.statusCode} ${details.url.slice(0, 200)}`) })
  if (!strict) pageSession.webRequest.onErrorOccurred(details => { if (details.error !== 'net::ERR_ABORTED') failed(`${details.error} ${details.url.slice(0, 200)}`) })
  await mkdir(job.output, { recursive: true })
  for (const width of job.widths) result.views.push(await captureWidth(job, width, partition, result, signal))
  if (strict) result.status = !result.guardFailure && result.steps?.length === job.steps?.length && result.steps?.every(step => step.status === 'pass') && result.views.every(view => !view.error) ? 'pass' : 'stopped'
  return result
}

/** The capture mode of the app: read the job, write result.json next to the screenshots, exit. */
export function runCapture(jobPath: string): void {
  const controller = new AbortController()
  for (const signal of ['SIGTERM','SIGINT'] as const) process.once(signal, () => controller.abort())
  const userData = mkdtempSync(join(tmpdir(), 'fig-capture-'))
  app.setPath('userData', userData)
  app.dock?.hide()
  app.on('window-all-closed', () => {})
  void app.whenReady().then(async () => {
    let code = 0
    try {
      const job = JSON.parse(readFileSync(jobPath, 'utf8')) as CaptureJob
      const result = await capture(job, controller.signal)
      await writeFile(join(job.output, 'result.json'), JSON.stringify(result, null, 2))
    } catch (error) {
      console.error('fig-capture:', error instanceof Error ? error.message : error)
      code = 1
    }
    await rm(userData, { recursive: true, force: true }).catch(() => undefined)
    app.exit(code)
  })
}

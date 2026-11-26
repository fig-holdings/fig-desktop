import { BrowserWindow, net, type WebContents, type Session } from 'electron'
import { realpath } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAbsolute, relative, sep } from 'node:path'
import { interactiveTarget, previewKeys, type PreviewStep } from '../../harness/shared/preview-policy'

export interface StepResult { index: number; action: string; status: 'pass' | 'fail' | 'skipped' | 'cancelled'; elapsedMs: number; observation?: string; error?: string }
export interface StepJob {url: string; steps?: PreviewStep[]; allowedRoot?: string; allowMutation?: boolean}
const within = (root: string, path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel) }
export async function bounded<T>(value: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  try { return await Promise.race([value, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Preview step timed out')), ms)
    abort = () => reject(new Error('Preview cancelled'))
    signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort()
  })]) } finally {clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort)}
}
/** Installed before load. Capability is origin/root only; no credentials, general script or command RPC. */
export async function stepGuard(job: StepJob, page: WebContents, session: Session, failed: (message: string) => void) {
  const target = new URL(job.url), root = await realpath(job.allowedRoot!)
  if (!interactiveTarget(target)) throw new Error('Interactive capture requires an approved local target')
  let failure: string | undefined
  const pending = new Set<number>()
  const fail = (reason: string) => { failure ??= reason; if (!page.isDestroyed()) page.stop() }
  const allowed = async (value: string) => {
    try {
      const url = new URL(value)
      if (target.protocol === 'file:') return url.protocol === 'file:' && within(root, await realpath(fileURLToPath(url)))
      return ['http:', 'https:'].includes(url.protocol) && url.origin === target.origin && !url.username && !url.password
    } catch { return false }
  }
  const csp = `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'self'; form-action 'self'`
  session.webRequest.onBeforeRequest((details, callback) => {
    void (async () => {
      const permitted = !failure && details.resourceType !== 'subFrame' && (job.allowMutation || ['GET','HEAD'].includes(details.method)) && await allowed(details.url)
      if (!permitted) fail('Request outside the approved origin/root or operation policy')
      if (permitted) pending.add(details.id); else pending.delete(details.id)
      callback({cancel: !permitted})
    })().catch(() => {fail('Request guard failed'); callback({cancel: true})})
  })
  session.webRequest.onCompleted(details => {pending.delete(details.id); if (details.statusCode >= 400) failed('HTTP ' + details.statusCode + ' at approved target')})
  session.webRequest.onErrorOccurred(details => {pending.delete(details.id); if (details.error !== 'net::ERR_ABORTED') failed('Request failed or was blocked by preview policy')})
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const multipart = Object.entries(details.requestHeaders).some(([key, value]) => key.toLowerCase() === 'content-type' && String(value).toLowerCase().includes('multipart/form-data'))
    if (multipart) fail('File uploads are disabled')
    callback({cancel: Boolean(failure), requestHeaders: details.requestHeaders})
  })
  session.webRequest.onHeadersReceived((details, callback) => {
    const attachment = Object.entries(details.responseHeaders ?? {}).some(([key, values]) => key.toLowerCase() === 'content-disposition' && values.some(v => /attachment/i.test(v)))
    if (attachment) fail('Downloads are disabled')
    callback({cancel: Boolean(failure), responseHeaders: {...details.responseHeaders, 'Content-Security-Policy': [...details.responseHeaders?.['Content-Security-Policy'] ?? [], csp], 'X-DNS-Prefetch-Control': ['off']}})
  })
  if (target.protocol === 'file:') {
    session.protocol.handle('file', async request => {
      if (failure || !await allowed(request.url)) {fail('File resource escapes the approved realpath root'); return new Response('', {status: 403})}
      const canonical = pathToFileURL(await realpath(fileURLToPath(request.url))).href
      const response = await net.fetch(canonical, {bypassCustomProtocolHandlers: true})
      const headers = new Headers(response.headers); headers.append('Content-Security-Policy', csp)
      return new Response(response.body, {status: response.status, headers})
    })
  }
  const navigation = (event: Electron.Event, value: string) => {
    try {
      const url = new URL(value)
      const lexical = target.protocol === 'file:' ? url.protocol === 'file:' && within(root, fileURLToPath(url)) : ['http:','https:'].includes(url.protocol) && url.origin === target.origin
      if (!lexical || failure) {event.preventDefault(); fail('Navigation outside the approved origin/root')}
    } catch {event.preventDefault(); fail('Invalid navigation target')}
  }
  page.on('will-navigate', navigation); page.on('will-redirect', navigation)
  page.on('will-frame-navigate', event => { if (!event.isMainFrame) {event.preventDefault(); fail('Embedded frames are disabled')} })
  page.on('frame-created', (_event, details) => {if (details.frame?.parent) fail('Embedded frames are disabled')})
  page.setWindowOpenHandler(() => {fail('New windows are disabled'); return {action: 'deny'}})
  const download = (event: Electron.Event) => {event.preventDefault(); fail('Downloads are disabled')}
  session.on('will-download', download)
  // Intercept native file choosers, including a click handler that proxies to a hidden file input.
  page.debugger.attach('1.3')
  await page.debugger.sendCommand('Page.enable')
  await page.debugger.sendCommand('Page.setInterceptFileChooserDialog', {enabled: true})
  await page.debugger.sendCommand('Runtime.enable')
  // WebRTC's ICE/TURN traffic bypasses Chromium's HTTP webRequest observer. Disable that
  // page capability before any task code, including the legacy constructor alias. Frames
  // and workers are separately denied, so they cannot supply a fresh realm.
  await page.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {source: `for (const key of ['RTCPeerConnection','webkitRTCPeerConnection']) Object.defineProperty(globalThis,key,{value:undefined,writable:false,configurable:false})`})
  await page.debugger.sendCommand('Runtime.addBinding', {name: '__figCapturePolicyViolation', executionContextName: 'fig-capture-policy'})
  await page.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {worldName: 'fig-capture-policy', source: `document.addEventListener('securitypolicyviolation', () => globalThis.__figCapturePolicyViolation('blocked'), true)`})
  page.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  page.debugger.on('message', (_event, method, params) => {
    if (method === 'Page.fileChooserOpened') fail('File selection is disabled')
    if (method === 'Runtime.bindingCalled' && params.name === '__figCapturePolicyViolation') fail('Page content security policy blocked an operation')
  })
  return {
    get failure() {return failure}, fail,
    async check() {
      if (failure) throw new Error(failure)
      if (!await allowed(page.getURL())) {fail('Current target no longer matches approval'); throw new Error(failure)}
      const embedded = await page.executeJavaScriptInIsolatedWorld(973, [{code: "Boolean(document.querySelector('iframe,frame,object,embed'))"}])
      if (embedded) {fail('Embedded content is disabled'); throw new Error(failure)}
    },
    async settle() {
      let quiet = Date.now()
      for (;;) {
        if (failure) throw new Error(failure)
        if (pending.size || page.isLoading()) quiet = Date.now()
        if (Date.now() - quiet >= 100) return
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    },
    dispose() {
      session.removeListener('will-download', download)
      session.webRequest.onBeforeRequest(null); session.webRequest.onBeforeSendHeaders(null); session.webRequest.onHeadersReceived(null); session.webRequest.onCompleted(null); session.webRequest.onErrorOccurred(null)
      if (target.protocol === 'file:') session.protocol.unhandle('file')
      if (!page.isDestroyed() && page.debugger.isAttached()) page.debugger.detach()
    }
  }
}
/** Fixed isolated-world DOM operations. The model supplies data only, never JavaScript. */
function domStep(step: PreviewStep) {
  const matches = document.querySelectorAll(step.selector)
  const visible = (element: Element) => {const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'}
  if (step.action === 'waitFor') {
    const state = step.state ?? 'visible', present = matches.length > 0
    const ready = state === 'attached' ? present : state === 'detached' ? !present : state === 'visible' ? present && [...matches].some(visible) : !present || [...matches].every(el => !visible(el))
    return {ready, observation: present ? (matches[0].textContent ?? '').replace(/\s+/g, ' ').slice(0, 200) : 'not present'}
  }
  if (matches.length !== 1) throw new Error('Action selector must identify exactly one element')
  const element = matches[0] as HTMLElement
  if (!visible(element) || element.matches(':disabled,[aria-disabled="true"]')) throw new Error('Action target is not enabled and visible')
  const unsafe = (el: HTMLElement) => el.matches('iframe,frame,object,embed,input[type="file"],input[type="password"]') || Boolean(el.closest('a[download],a[target="_blank"]')) || /password|passwd|secret|token|api.?key|authorization|cookie|credential|access.?key|refresh.?key|one.?time.?code|otp/i.test([el.getAttribute('name'), el.id, el.getAttribute('autocomplete')].join(' '))
  if (unsafe(element)) throw new Error('Secret, file, embedded or new-window controls are disabled')
  element.scrollIntoView({block: 'center'}); element.focus()
  if (unsafe(element)) throw new Error('Action target changed while focusing')
  if (step.action === 'click') element.click()
  if (step.action === 'fill') {
    if (element.matches('[readonly]')) throw new Error('Fill target is read-only')
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('Fill requires a non-secret input or textarea')
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, step.text)
    element.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: step.text}))
  }
  return {ready: true, observation: (element.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200)}
}
export async function runSteps(job: StepJob, page: WebContents, guard: Awaited<ReturnType<typeof stepGuard>>, signal?: AbortSignal): Promise<StepResult[]> {
  const results: StepResult[] = []
  for (const [index, step] of job.steps!.entries()) {
    if (results.some(result => result.status !== 'pass')) {results.push({index: index + 1, action: step.action, status: 'skipped', elapsedMs: 0, error: 'Previous step did not complete'}); continue}
    const start = Date.now()
    try {
      const perform = async () => {
        signal?.throwIfAborted(); await guard.check()
        let observation = ''
        for (;;) {
          const value = await page.executeJavaScriptInIsolatedWorld(973, [{code: `(${domStep.toString()})(${JSON.stringify(step)})`}], true)
          observation = value.observation
          if (value.ready) break
          await new Promise(resolve => setTimeout(resolve, 40))
          signal?.throwIfAborted()
        }
        if (step.action === 'press') {
          if (!previewKeys.includes(step.key!)) throw new Error('Unsupported key')
          page.sendInputEvent({type: 'keyDown', keyCode: step.key!}); page.sendInputEvent({type: 'keyUp', keyCode: step.key!})
        }
        await new Promise(resolve => setTimeout(resolve, 50)); await guard.settle(); await guard.check(); return observation
      }
      const observation = await bounded(perform(), 5000, signal)
      results.push({index: index + 1, action: step.action, status: 'pass', elapsedMs: Date.now() - start, observation})
    } catch (error) {
      if (!page.isDestroyed()) BrowserWindow.fromWebContents(page)?.destroy()
      guard.fail('Step stopped: ' + (error instanceof Error ? error.message : 'unknown failure'))
      results.push({index: index + 1, action: step.action, status: signal?.aborted ? 'cancelled' : 'fail', elapsedMs: Date.now() - start, error: error instanceof Error ? error.message : 'Step failed'})
    }
  }
  return results
}

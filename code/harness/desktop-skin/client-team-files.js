import { t } from './client-locale.js'

/** One owner for this action, removed with the contributing client plugin. */
export function teamFileActions() {
  let upload
  const service = Object.freeze({ version: 1, registerUpload(handler) {
    if (typeof handler !== 'function' || upload) throw new Error('Invalid or duplicate Cowork upload handler')
    upload = handler
    return () => { if (upload === handler) upload = undefined }
  } })
  return { service, handler: () => upload }
}

function localDirectory(cwd, path) {
  const value = path.startsWith('/') ? path : cwd?.startsWith('/') && `${cwd}/${path}`
  if (!value || value.includes('\0')) return undefined
  const pieces = []
  for (const piece of value.split('/')) {
    if (piece === '..') pieces.pop()
    else if (piece && piece !== '.') pieces.push(piece)
  }
  return '/' + pieces.join('/')
}

/** DSH uses the same native file target for its tree, file references, and cards in a completed turn. */
export function installTeamFileActions(ctx, profile, actions, picker = globalThis.__FIG_TEAM_FILES__) {
  let active = true
  async function localPath(kind, { sessionId, path }, signal) {
    if (!sessionId || typeof path !== 'string') return undefined
    if (kind !== 'directory') {
      const result = await ctx.remote.workspaceFiles.stat(sessionId, path, signal)
      return result.ok && result.value.absolutePath?.startsWith('/') ? result.value.absolutePath : undefined
    }
    const result = await ctx.remote.workspaceFiles.list(sessionId, path, signal)
    const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
    return result.ok ? localDirectory(cwd, path) : undefined
  }
  const openChangedFileMenu = event => {
    if (event.defaultPrevented || !picker || profile.getSnapshot()?.edition !== 'team' || !actions.handler() || !(event.target instanceof Element)) return
    const card = event.target.closest('[aria-describedby]')
    if (!card?.closest('[data-changed-files]')) return
    const path = document.getElementById(card.getAttribute('aria-describedby'))?.textContent
    const sessionId = card.closest('[data-conversation-session]')?.getAttribute('data-conversation-session')
    if (!sessionId || !path?.startsWith('/')) return
    event.preventDefault()
    ctx.contextMenus.open({ kind: 'file', value: { sessionId, path } }, { x: event.clientX, y: event.clientY })
  }
  const stops = ['file', 'directory', 'image'].map(kind => ctx.contextMenus.register({
    id: 'fig-team-files.upload', target: kind, order: 250,
    async resolve(target, signal) {
      const upload = actions.handler()
      if (!picker || !upload || (await profile.ready)?.edition !== 'team') return []
      const path = await localPath(kind, target, signal).catch(() => undefined)
      signal.throwIfAborted()
      if (!path) return []
      const run = async (pick = false) => {
        if (!active || actions.handler() !== upload) return
        // Re-read authority at click time, in case the captured file was moved or the Session changed.
        const current = await localPath(kind, target, AbortSignal.timeout(5000))
        if (current !== path) throw new Error('Local file is unavailable')
        const folder = kind === 'directory' ? path : path.slice(0, path.lastIndexOf('/')) || '/'
        const paths = pick ? await picker.pick(folder) : [path]
        if (active && actions.handler() === upload && paths.length)
          await upload(Object.freeze({ paths: Object.freeze([...new Set(paths)]), sessionId: target.sessionId }))
      }
      const failureLabel = t('team-files.uploadFailed')
      return [
        { id: 'upload', label: t('team-files.upload'), failureLabel, run: () => run() },
        { id: 'pick', label: t('team-files.pick'), failureLabel, run: () => run(true) }
      ]
    }
  }))
  globalThis.document?.addEventListener('contextmenu', openChangedFileMenu)
  return () => {
    active = false
    globalThis.document?.removeEventListener('contextmenu', openChangedFileMenu)
    for (const stop of stops) stop()
  }
}

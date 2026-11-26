import { resolve, isAbsolute } from 'node:path'

// Session facts only: never scan the repository or parse prose links as deliveries.
const documents = /\.(?:md|mdx|txt|rst|adoc|html?|pdf|docx?|odt|rtf|xlsx?|csv|tsv|ods|pptx?|odp)$/i
export function sessionOutputs(events, cwd) {
  const calls = new Map(), files = new Map()
  const add = (path, seq, explicit = false, description) => {
    if (typeof path !== 'string' || !path.trim() || (!explicit && !documents.test(path))) return
    if (!isAbsolute(path) && !cwd) return
    const absolute = resolve(cwd || '/', path)
    files.set(absolute, { path: absolute, name: absolute.split(/[\\/]/).pop(), seq, description })
  }
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const data = event.data
    if (!data || typeof data !== 'object') continue
    if (event.type === 'tool/call') {
      let args
      try { args = JSON.parse(data.arguments) } catch { continue }
      const mutation = data.name === 'write' && typeof args?.content === 'string'
        || data.name === 'edit' && typeof args?.old_string === 'string' && args.old_string.length > 0 && typeof args.new_string === 'string' && args.old_string !== args.new_string
        || data.name === 'str_replace_editor' && (args?.command === 'create' && typeof args.file_text === 'string'
          || args?.command === 'str_replace' && typeof args.old_str === 'string' && args.old_str.length > 0 && (args.new_str === undefined || typeof args.new_str === 'string')
          || args?.command === 'insert' && Number.isInteger(args.insert_line) && args.insert_line >= 0 && typeof args.new_str === 'string')
      if (mutation) calls.set(data.callId, args.file_path ?? args.path)
    } else if (event.type === 'tool/result' && data.message?.isError !== true) {
      const path = calls.get(data.message?.source?.callId)
      if (path) {
        const meta = data.meta ?? data.message?.meta
        // Modern records carry the exact resolved target; malformed relative metadata must not be guessed.
        if (meta && Object.hasOwn(meta, 'path')) { if (typeof meta.path === 'string' && isAbsolute(meta.path)) add(meta.path, event.seq) }
        else add(path, event.seq)
      }
    } else if (event.type === 'deliverables/presented' && Array.isArray(data.files)) {
      for (const file of data.files) add(file?.path, event.seq, true, file?.description)
    }
  }
  return [...files.values()].sort((a, b) => b.seq - a.seq || a.path.localeCompare(b.path))
}

const PULL_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?![\w/])/g
/** Pull requests the session tracks at most; the newest win. */
export const SESSION_PULL_LIMIT = 10

const GH_PR = /(^|[\s;&|(])gh\s+pr\s/
const BACKGROUND_JOB = /moved to background job (bash-[\w-]+)/

/**
 * The pull requests this Session worked with: GitHub pull request links in the successful output of its bash commands
 * that ran `gh pr …` (create, view, checks, merge…), newest first. Links in prose, file reads or other commands do
 * not count. A command that outlives the bash tool's wait becomes a background job: its output, and so the link, comes
 * back later through `job_output` for that job id, which is followed too.
 * @param {any[]} events
 */
export function sessionPullUrls(events) {
  const calls = new Set(), jobs = new Set(), seen = new Map()
  const textOf = message => (Array.isArray(message?.content) ? message.content : []).filter(part => part?.type === 'text').map(part => String(part.text)).join('\n')
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const data = event.data
    if (!data || typeof data !== 'object') continue
    if (event.type === 'tool/call' && (data.name === 'bash' || data.name === 'job_output')) {
      let args
      try { args = JSON.parse(data.arguments) } catch { continue }
      if (data.name === 'bash' ? typeof args?.command === 'string' && GH_PR.test(args.command) : jobs.has(args?.job_id)) calls.add(data.callId)
    } else if (event.type === 'job/registered' && data.kind === 'bash' && typeof data.label === 'string' && GH_PR.test(data.label)) {
      jobs.add(data.jobId)
    } else if (event.type === 'tool/result' && data.message?.isError !== true && calls.has(data.message?.source?.callId)) {
      const text = textOf(data.message)
      const job = BACKGROUND_JOB.exec(text)?.[1]
      if (job) jobs.add(job)
      for (const url of text.match(PULL_URL) ?? []) { seen.delete(url); seen.set(url, event.seq) }
    }
  }
  return [...seen.keys()].reverse().slice(0, SESSION_PULL_LIMIT)
}

/** Cold-safe, paged history; never activates an Agent. A bound is surfaced instead of implying completeness. */
export async function readOutputs(controller, sessionId, signal) {
  const events = []
  let beforeSeq, throughSeq, cwd, more = true
  for await (const frame of controller.follow({ address: { kind: 'session', sessionId }, maxMessages: 1 }, signal)) {
    if (frame.type === 'snapshot') { cwd = frame.header.cwd; throughSeq = frame.cursor; break }
  }
  for (let page = 0; page < 100 && more; page++) {
    const value = await controller.events({ address: { kind: 'session', sessionId }, maxMessages: 100, beforeSeq, throughSeq }, signal)
    throughSeq ??= value.cursor
    const batch = value.records.map(record => record.event)
    if (!batch.length) break
    events.push(...batch)
    const first = Math.min(...batch.map(event => event.seq))
    if (beforeSeq !== undefined && first >= beforeSeq) throw new Error('Output history cursor did not advance')
    beforeSeq = first
    more = value.hasMore
  }
  for (const event of events) if (event.type === 'session/start') cwd = event.data?.cwd ?? cwd
  return { files: sessionOutputs(events, cwd), pullUrls: sessionPullUrls(events), truncated: more }
}

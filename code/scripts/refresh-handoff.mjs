// Verification-only exclusive grant transfer through the native credential service. Source holds
// an inert marker while the isolated Host owns refresh. Crash recovery uses the latest copy.
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { grantCredential } from '../harness/provider-chatgpt/session.js'
import { BlockedError } from './verification-lifecycle.mjs'

const key = 'fig-chatgpt/subscription'
const marker = 'fig-verification-handoff'

export function assertNoDshOwner() {
  let processes
  try {
    processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 })
  } catch {
    throw new BlockedError('Cannot verify absence of a live DSH owner; refresh handoff blocked')
  }
  const live = processes.split('\n').some(line => {
    const command = line.trim().replace(/^\d+\s+/, '')
    return /^(?:\S*\/)?(?:node|dsh)(?:\s|$)/.test(command) && /@deepseek-ai\/dsh\/lib\/bin\.js|(?:^|\s)\S*\/dsh(?:\s|$)/.test(command)
  })
  if (live) throw new BlockedError('A DSH owner is running; exclusive refresh blocked to avoid concurrent grant rotation')
}

export async function nativeCredentialStore(filename, modules) {
  if (!modules || !isAbsolute(modules)) throw new BlockedError('Exclusive refresh requires installed fixed DSH --dsh-modules path')
  const require = createRequire(join(modules, 'package.json'))
  const [{ Context }, { LocalCredentialProvider }] = await Promise.all([
    import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')).href)
  ])
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { path: filename, watch: false })
  await fiber
  if (!ctx.credentials) {
    await fiber.dispose()
    throw new BlockedError('Native credential service unavailable')
  }
  return { credentials: ctx.credentials, close: () => fiber.dispose() }
}

const journalFor = source => source + '.fig-verification-handoff.json'

export async function acquireRefreshHandoff({ source, target, modules, checkOwner = assertNoDshOwner }) {
  if (!isAbsolute(source) || !isAbsolute(target) || source === target) throw new BlockedError('Refresh handoff requires distinct absolute credential paths')
  checkOwner()
  const journal = journalFor(source)
  const owner = randomUUID()
  const metadata = { schema: 1, owner, pid: process.pid, source, target, startedAt: new Date().toISOString() }
  await writeFile(journal, JSON.stringify(metadata) + '\n', { flag: 'wx', mode: 0o600 }).catch(() => {
    throw new BlockedError('Unresolved refresh handoff exists; recover it before another run')
  })
  const store = await nativeCredentialStore(source, modules).catch(async error => {
    await rm(journal, { force: true })
    throw error
  })
  let claimed = false, original
  const handoff = {
    metadata: { mode: 'exclusive-transfer', journal, expiredBefore: false, returned: false },
    async release() {
      checkOwner() // app.close alone cannot prove that a detached Host actually exited.
      const latest = parse(await readFile(target, 'utf8'))?.records?.[key]
      if (!grantCredential(latest)) throw new BlockedError('Latest isolated grant unavailable; recovery copy and journal retained')
      let restored = false, conflict = false
      await store.credentials.modifyRecord(key, async current => {
        if (current?.kind === 'grant' && current.payload?.type === marker && current.payload.owner === owner) { restored = true; return latest }
        if (grantCredential(current)) { conflict = true; return current }
        throw new BlockedError('Source ownership changed; recovery copy retained instead of overwriting credentials')
      })
      if (!restored && !conflict) throw new BlockedError('Refresh return not confirmed')
      handoff.metadata = { ...handoff.metadata, returned: true, newLoginWon: conflict, rotated: latest.payload.access !== original?.access, expiresAfter: latest.payload.expires }
      await rm(journal)
      await store.close()
      return handoff.metadata
    }
  }
  try {
    await store.credentials.modifyRecord(key, async current => {
      original = grantCredential(current)
      if (!original) throw new BlockedError('Valid canonical ChatGPT grant unavailable')
      handoff.metadata.expiredBefore = original.expires <= Date.now()
      await mkdir(dirname(target), { recursive: true })
      const existing = await readFile(target, 'utf8').then(parse, error => {
        if (error.code === 'ENOENT') return { version: 1, records: {} }
        throw error
      })
      existing.records ??= {}
      existing.records[key] = current
      await writeFile(target, JSON.stringify(existing) + '\n', { mode: 0o600, flag: 'w' })
      return { kind: 'grant', payload: { type: marker, owner } }
    })
    claimed = true
    checkOwner()
    return handoff
  } catch (error) {
    // A storage error can be reported after a commit. Inspect persisted ownership before
    // deleting the journal; an uncertain return must always remain recoverable.
    if (!claimed) {
      try {
        const persisted = parse(await readFile(source, 'utf8'))?.records?.[key]
        claimed = persisted?.payload?.type === marker && persisted.payload.owner === owner
      } catch {
        await store.close()
        throw Object.assign(new BlockedError('Cannot establish persisted refresh ownership; journal and isolated copy retained'), { retainCredentials: true, recoveryJournal: journal })
      }
    }
    if (claimed) {
      try {
        await handoff.release()
      } catch {
        throw Object.assign(new BlockedError('Refresh ownership return failed; journal and latest credential copy retained'), { retainCredentials: true, recoveryJournal: journal })
      }
    } else {
      await store.close()
      await rm(journal, { force: true })
    }
    if (error instanceof BlockedError) throw error
    throw new BlockedError('Exclusive refresh handoff failed before model launch')
  }
}

export async function recoverRefreshHandoff({ source, modules, checkOwner = assertNoDshOwner }) {
  checkOwner()
  const journal = journalFor(source)
  const meta = JSON.parse(await readFile(journal, 'utf8'))
  try {
    process.kill(meta.pid, 0)
    throw new BlockedError('Refresh owner still alive; automatic takeover refused')
  } catch (/** @type {any} */ error) {
    if (error.code !== 'ESRCH') throw error
  }
  const latest = parse(await readFile(meta.target, 'utf8'))?.records?.[key]
  if (!grantCredential(latest)) throw new BlockedError('No valid latest grant in recovery copy')
  const store = await nativeCredentialStore(source, modules)
  try {
    await store.credentials.modifyRecord(key, async current => {
      if (current?.payload?.type === marker && current.payload.owner === meta.owner) return latest
      if (grantCredential(current)) return current
      throw new BlockedError('Source ownership cannot be proven during recovery')
    })
    await rm(journal)
  } finally {
    await store.close()
  }
  return { returned: true, recoveryCopy: meta.target }
}

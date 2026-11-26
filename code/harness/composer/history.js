import { readFile } from 'node:fs/promises'
import { writeRecord } from '../shared/atomic-json.ts'

// Sent text per workspace, newest last. The DSH page runs on a new port every launch,
// so browser storage would start empty each time; the Host keeps the list instead.
export const historyLimit = 200
export const scopeLimit = 20
export const textLimit = 8000

export function historyStore(path) {
  let loading
  let writing = Promise.resolve()

  // One read shared by every caller, so an add during the first read cannot save a partial map.
  const load = () => (loading ??= read())

  async function read() {
    const scopes = new Map()
    try {
      const data = JSON.parse(await readFile(path, 'utf8'))
      for (const [scope, entries] of Object.entries(data?.scopes ?? {}).slice(-scopeLimit)) {
        if (Array.isArray(entries)) scopes.set(scope, entries.filter(valid).slice(-historyLimit))
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') console.warn('[fig-composer] input history unreadable, starting empty')
    }
    return scopes
  }

  async function save() {
    await writeRecord(path, { version: 1, scopes: Object.fromEntries(await load()) })
  }

  return {
    async list(scope) {
      return [...((await load()).get(scope) ?? [])]
    },
    async add(scope, text) {
      if (!valid(text) || !text.trim()) return false
      const map = await load()
      const previous = map.get(scope) ?? []
      if (previous.at(-1) === text) return false
      // Re-inserting moves the workspace to the newest end, so the oldest one is dropped first.
      map.delete(scope)
      map.set(scope, [...previous, text].slice(-historyLimit))
      while (map.size > scopeLimit) map.delete(map.keys().next().value)
      writing = writing.then(save, save)
      await writing
      return true
    }
  }
}

function valid(text) {
  return typeof text === 'string' && text.length <= textLimit
}

import { readRecord, writeRecord } from '../shared/atomic-json.ts'
import { validAppearance } from './model.js'
import { RouteError } from '../shared/http.js'

/** @type {(value: any) => value is {version: 1, projects: Record<string, unknown>}} */
const valid = value => value?.version === 1 && Boolean(value.projects) && typeof value.projects === 'object' && !Array.isArray(value.projects)

// A damaged file is set aside (readRecord) and the projects start from the default look, rather than failing every read.
export function appearanceStore(path) {
  let queue = Promise.resolve(), loaded
  const load = () => loaded ??= readRecord(path, valid, { version: 1, projects: {} })
    .then(data => Object.fromEntries(Object.entries(data.projects).filter(([, value]) => validAppearance(value))))
  return {
    async list() { await queue; return { ...(await load()) } },
    set(id, value) {
      if (typeof id !== 'string' || !id || id.length > 256 || (value !== null && !validAppearance(value))) throw new RouteError(400, 'INVALID_APPEARANCE')
      const operation = queue.then(async () => {
        const next = { ...(await load()) }
        if (value === null) delete next[id]
        else next[id] = { icon: value.icon, color: value.color }
        await writeRecord(path, { version: 1, projects: next })
        loaded = Promise.resolve(next)
        return next
      })
      queue = operation.then(() => {}, () => {})
      return operation
    }
  }
}

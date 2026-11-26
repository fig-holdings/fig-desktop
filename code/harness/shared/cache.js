/**
 * Keeps the latest value of one slow lookup (a model catalog, an allowance) for `ttl` ms.
 * Concurrent callers share one load; a load for another key replaces the cached value.
 */
export function ttlCache(ttl) {
  let cached
  let pending

  return {
    get(load, key = '') {
      if (cached?.key === key && cached.expires > Date.now()) return Promise.resolve(cached.value)
      if (pending?.key === key) return pending.value
      if (cached?.key !== key) cached = undefined
      const value = load().then(result => {
        if (pending?.value === value) cached = { key, value: result, expires: Date.now() + ttl }
        return result
      }).finally(() => { if (pending?.value === value) pending = undefined })
      pending = { key, value }
      return value
    },
    /** The last loaded value, even after it expired. */
    get last() { return cached?.value },
    /** Keeps the value readable through `last` but reloads it on the next `get`. */
    expire() { if (cached) cached.expires = 0 },
    forKey(key) { return cached?.key === key ? cached.value : undefined },
    clearKey(key) {
      if (cached?.key === key) cached = undefined
      if (pending?.key === key) pending = undefined
    },
    clear() { cached = undefined; pending = undefined }
  }
}

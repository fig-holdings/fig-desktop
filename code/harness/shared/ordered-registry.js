// The registration table behind Fig's page extension points (task activity's `figActivity`, desktop-skin's
// `figWorkspacePicker`): other plugins add entries by key and get a handle to update or dispose them; readers list
// them by `order` (lower first) and re-render through `subscribe`/`getSnapshot`.

export function orderedRegistry() {
  /** key → registration */
  const entries = new Map()
  const listeners = new Set()
  let snapshot = 0
  const publish = () => { snapshot++; for (const listener of listeners) listener() }
  return {
    publish,
    /**
     * Adds `entry` under `key`, replacing any earlier one. `fixed` fields win over every update (an entry's own id or
     * kind never change). A handle whose entry was replaced or disposed does nothing.
     */
    add(key, entry, fixed = {}) {
      let current = entry
      entries.set(key, current)
      publish()
      return {
        update(patch) {
          if (entries.get(key) !== current) return
          current = { ...current, ...patch, ...fixed }
          entries.set(key, current)
          publish()
        },
        dispose() {
          if (entries.get(key) !== current) return
          entries.delete(key)
          publish()
        }
      }
    },
    /** The registrations `filter` keeps, lower `order` first. */
    list: (filter = () => true) => [...entries.values()].filter(filter).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** A version number that changes with every change. */
    getSnapshot: () => snapshot
  }
}

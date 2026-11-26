// Host provider names are not localized; Fig's subscription groups are named for the page language. DSH offers no
// hook for group names, so this projects the original ModelDirectory snapshot only; the picker, selection RPCs and
// keyboard behavior stay DSH's. An unfamiliar snapshot shape passes through untouched.
// Each subscription plugin names its own group; one projection serves them all, installed by the first and
// restored when the last one unloads.

const registry = Symbol.for('fig.model-group-names')

/**
 * Names the model picker group `id` with `name()` (the caller's text in the page language) while the caller's plugin
 * is loaded; returns the disposer.
 * @param {(id: string) => any} loadModule the page plugin factory's `require`
 * @param {string} id @param {() => string} name
 */
export function nameModelGroup(loadModule, id, name) {
  const state = globalThis[registry] ??= { names: new Map(), restore: undefined }
  state.names.set(id, name)
  state.restore ??= project(loadModule, state.names)
  return () => {
    if (state.names.get(id) !== name) return
    state.names.delete(id)
    if (state.names.size === 0) { state.restore?.(); state.restore = undefined }
  }
}

function project(loadModule, groupNames) {
  const proto = loadModule('@deepseek-ai/dsh-client-ui-model-selection')?.ModelDirectoryResolver?.prototype
  const resolve = proto?.directoryFor
  if (typeof resolve !== 'function') return () => {}
  // store -> its original reader and the wrapper; `stores` lets the disposer find them again.
  const wrapped = new WeakMap(), stores = []
  proto.directoryFor = function (sessionId) {
    const directory = resolve.call(this, sessionId)
    const store = directory?.store
    if (!store || wrapped.has(store) || typeof store.getSnapshot !== 'function') return directory
    const read = store.getSnapshot
    let before, labels, projected
    const projectSnapshot = () => {
      const snapshot = read()
      if (!Array.isArray(snapshot?.groups)) return snapshot
      // The names follow the page language: a new projection when the snapshot or any name changes, else the same one.
      const names = new Map([...groupNames].map(([id, name]) => [id, name()]))
      const current = [...names].join('\n')
      if (snapshot !== before || current !== labels) {
        before = snapshot
        labels = current
        projected = { ...snapshot, groups: snapshot.groups.map(group => groupNames.has(group.id)
          ? { ...group, name: names.get(group.id) } : group) }
      }
      return projected
    }
    wrapped.set(store, { read, project: projectSnapshot })
    stores.push(new WeakRef(store))
    store.getSnapshot = projectSnapshot
    return directory
  }
  // Restores the resolver and every store still carrying the wrapper.
  return () => {
    proto.directoryFor = resolve
    for (const ref of stores) {
      const store = ref.deref(), entry = store && wrapped.get(store)
      if (entry && store.getSnapshot === entry.project) store.getSnapshot = entry.read
    }
  }
}

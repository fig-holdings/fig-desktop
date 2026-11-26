// Where the open conversation is now lives with the other DSH internals; side chat, rule sources and shell-bridge
// still import these two from here.
export { openConversation, openSessionId } from './dsh-internals.js'

/** The Host checks the browser's DSH session on each Fig request. */
export async function postPageJson(prefix, endpoint, payload) {
  const response = await fetch(prefix + '/' + endpoint, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return { response, result: await response.json().catch(() => undefined) }
}

const noSubscription = () => () => {}
const subscribers = new WeakMap()
/**
 * Reads a `{ subscribe, getSnapshot }` store (DSH's hooks and services, Fig's own stores) in a component; `fallback`
 * while the store is missing or has no value. One subscribe function per store, so React does not resubscribe on
 * every render. Pass the factory's React: page plugins do not import it.
 * @param {typeof import('react')} react
 */
export function useStore(react, store, fallback) {
  let subscribe = noSubscription
  if (store) {
    subscribe = subscribers.get(store)
    if (!subscribe) { subscribe = listener => store.subscribe(listener) ?? (() => {}); subscribers.set(store, subscribe) }
  }
  return react.useSyncExternalStore(subscribe, () => store?.getSnapshot() ?? fallback)
}

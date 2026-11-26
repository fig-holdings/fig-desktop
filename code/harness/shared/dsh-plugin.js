import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Helpers shared by Fig's host plugins. Each plugin's host entry (index.js) is bundled through
// electron.vite.config.ts's rollup input, so these are bundled in; nothing extra to copy.

/** Resolve a DSH package against the running DSH binary (process.argv[1]). */
export const dshResolve = module => createRequire(process.argv[1]).resolve(module)

/** Dynamic-import a DSH package, resolved against the running DSH binary. */
export const fromDsh = module => import(pathToFileURL(dshResolve(module)).href)

export { dshHome } from './dsh-home.js'

/** A text content block for a tool result. */
export const textBlock = text => ({ type: 'text', text })

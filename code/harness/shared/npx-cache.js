import { homedir } from 'node:os'
import { join } from 'node:path'

/** Fig's own cache folder: npm's executable cache, the pnpm shim and the development host live under it. */
export const figCacheRoot = (home = homedir()) => join(home, 'Library/Caches/fig-desktop')
/** Fig's npm cache, used when Fig installs DSH (shared/dsh-runtime.js) and runs the pnpm fallback; kept apart from Application Support and DSH data. */
export const figNpmCache = (home = homedir()) => join(figCacheRoot(home), 'npm')

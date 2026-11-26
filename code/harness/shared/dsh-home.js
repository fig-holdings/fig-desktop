import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// Kept apart from dsh-plugin.js so code outside a DSH plugin (ui-text.ts, which main also bundles) can read the same
// default without dsh-plugin.js's createRequire on the DSH binary.

/** DSH's home: DSH_HOME when Fig set an absolute one, else Fig's default ~/.fig. */
export function dshHome() {
  const home = process.env.DSH_HOME
  return home && isAbsolute(home) ? home : join(homedir(), '.fig')
}

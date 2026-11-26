import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshRuntimeRoot, ensureDshRuntime, readRuntimeLock } from '../harness/shared/dsh-runtime.js'

/** npm's CLI script for this Node: the one running this script under `npm run`, else the one beside Node. */
export function npmCli() {
  const running = process.env.npm_execpath
  if (running?.endsWith('npm-cli.js')) return running
  return realpathSync(join(dirname(process.execPath), 'npm'))
}

/**
 * The folder holding the manifest and lockfile DSH `version` installs from: the candidate lockfile
 * scripts/dsh-verify.mjs wrote (FIG_DSH_CANDIDATE_LOCK) when it pins `version`, else the committed one (code/dsh-runtime/).
 * @param {string} code @param {string} version
 */
export async function lockFolder(code, version) {
  for (const folder of [process.env.FIG_DSH_CANDIDATE_LOCK, join(code, 'dsh-runtime')]) {
    if (folder && (await readRuntimeLock(folder)).manifest.dependencies['@deepseek-ai/dsh'] === version) return folder
  }
  throw new Error(`No lockfile for DSH ${version}: run npm run dsh:verify -- ${version}`)
}

/**
 * Installs DSH `version` from its lockfile the way Fig does (shared/dsh-runtime.js), so smoke tests start from a
 * finished install rather than racing a first download. Returns the entry and the install folder.
 * @param {string} version
 * @param {{ code: string, root?: string }} options
 */
export async function prepareDshCache(version, { code, root = dshRuntimeRoot() }) {
  const locked = await readRuntimeLock(await lockFolder(code, version))
  const { entry, folder } = await ensureDshRuntime({ ...locked, root, node: process.execPath, npm: npmCli(),
    signal: AbortSignal.timeout(900_000), onInstall: () => console.log(`Installing DSH ${version} from its lockfile…`) })
  return { entry, folder }
}

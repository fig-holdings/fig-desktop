import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { prepareDshCache } from '../../scripts/dsh-cache.mjs'

const code = fileURLToPath(new URL('../..', import.meta.url))

/** The DSH release under test: the candidate being verified, else the one Fig starts. */
export async function testedDsh() {
  const candidate = process.env.FIG_DSH_CANDIDATE
  if (candidate) return candidate
  const { verified } = JSON.parse(await readFile(new URL('../../harness/dsh-versions.json', import.meta.url), 'utf8'))
  return verified.at(-1)
}

/** The `dsh` launcher of `version`, installed from its lockfile the way Fig installs it (installs it when missing). */
export async function dshLauncher(version) {
  return (await prepareDshCache(version, { code })).entry
}

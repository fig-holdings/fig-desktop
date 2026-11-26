import { readFile } from 'node:fs/promises'
import { findPackageJSON } from 'node:module'
import { pathToFileURL } from 'node:url'
import versions from './dsh-versions.json'
import { uiText } from './shared/ui-text'
import { dshReleasePattern } from './shared/dsh-range'

// The DSH releases Fig has verified. Until Fig's first release the list holds only the newest one
// (accepting a release replaces it). Fig starts it; plugin `engines.dsh` (electron.vite.config.ts) and
// the provider plugins' version gate (unverifiedDsh below) come from the same list. A release under
// verification is passed to the build as FIG_DSH_CANDIDATE; the build writes it into the plugins' `engines.dsh`
// and into `acceptedDsh` below, so plugins never read it from the environment.
export const verifiedDsh: readonly string[] = versions.verified
export const launchDsh = verifiedDsh.at(-1) as string

// Replaced by the build (electron.vite.config.ts): the candidate it was built for, or null. Unbuilt sources have none.
declare const __FIG_DSH_CANDIDATE__: string | null | undefined
const builtCandidate = typeof __FIG_DSH_CANDIDATE__ === 'string' ? __FIG_DSH_CANDIDATE__ : undefined
/** The releases this build accepts at run time: the verified ones and the candidate it was built for. */
export const acceptedDsh: readonly string[] = builtCandidate ? [...verifiedDsh, builtCandidate] : verifiedDsh

/** The candidate named by FIG_DSH_CANDIDATE, if it is a plain release version. */
export function dshCandidate(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = environment.FIG_DSH_CANDIDATE
  return value && dshReleasePattern.test(value) ? value : undefined
}

/** The `engines.dsh` range for Fig's plugins: the verified releases, plus a candidate. */
export function dshEngines(candidate?: string): string {
  return [...new Set([...verifiedDsh, ...(candidate ? [candidate] : [])])].join(' || ')
}

export async function dshVersion(entry = process.argv[1]): Promise<string | undefined> {
  try {
    const manifest = findPackageJSON('@deepseek-ai/dsh', pathToFileURL(entry))
    if (!manifest) return undefined
    const { version } = JSON.parse(await readFile(manifest, 'utf8'))
    return typeof version === 'string' ? version : undefined
  } catch { return undefined }
}

/**
 * Returns a log-safe reason when this DSH is not one Fig's plugins were verified on. Fig's provider plugins
 * depend on DSH internals, so they stay unloaded on any release Fig has not verified
 * (harness/dsh-versions.json), except the candidate Fig started to verify.
 */
export async function unverifiedDsh(name: string, entry?: string): Promise<string | undefined> {
  const version = await dshVersion(entry)
  if (version && acceptedDsh.includes(version)) return
  return uiText(`${name} 未加载：当前 DSH ${version ?? '版本未知'} 未经验证（已验证 ${verifiedDsh.join(', ')}）。请更新 Fig Desktop。`,
    `${name} is not loaded: DSH ${version ?? '(unknown version)'} has not been verified (verified: ${verifiedDsh.join(', ')}). Update Fig Desktop.`)
}

import { execFile } from 'node:child_process'
import { access, chmod, constants, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'

// DSH installs and removes plugins with pnpm, found on PATH. Fig puts its own `pnpm` script first on DSH's PATH for
// two reasons:
// - Node's installers ship npm and npx but not pnpm. Without an installed pnpm, the script runs this exact pnpm 10
//   through the npx Fig already uses (downloaded on first use into Fig's npm cache). pnpm 11 treats dependency build
//   scripts differently from what DSH 0.2.2 expects, so the major stays 10.
// - DSH looks a package up with `pnpm view … --config.fetch-retries=0`. pnpm 10 hands `view` to npm with that flag,
//   and npm 12 rejects flags it does not know (EUNKNOWNCONFIG), so the Plugins page's 添加插件 failed for every
//   package. For view/info/show the script passes such `--config.<key>=<value>` flags as npm_config_<key> instead.
//   Removal condition: DSH stops passing pnpm-style flags to a command pnpm delegates to npm.

export const pnpmVersion = '10.34.9'

/** Shell single-quoting, for a path that may hold spaces or quotes. */
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** The script's text: run `pnpm` (an installed pnpm) or else npx's pinned pnpm. */
export function pnpmScript(npx: string, pnpm?: string): string {
  const run = pnpm ? `exec ${quoted(pnpm)} "$@"` : `exec ${quoted(npx)} --yes pnpm@${pnpmVersion} "$@"`
  return `#!/bin/sh
# Fig Desktop: DSH's pnpm. Rewrites --config.<key>=<value> on lookups for npm 12, then runs pnpm (app/main/pnpm-shim.ts).
case "$1" in
  view|info|show)
    first=1
    for arg in "$@"; do
      if [ "$first" = 1 ]; then set --; first=0; fi
      case "$arg" in
        --config.*=*)
          setting=\${arg#--config.}
          name=$(printf '%s' "\${setting%%=*}" | tr '.-' '__')
          export "npm_config_$name=\${setting#*=}" ;;
        *) set -- "$@" "$arg" ;;
      esac
    done ;;
esac
${run}
`
}

/** The version an executable pnpm reports, or undefined. */
function versionOf(pnpm: string): Promise<string | undefined> {
  return new Promise(resolve => execFile(pnpm, ['--version'], { timeout: 10_000 }, (error, stdout) => resolve(error ? undefined : stdout.trim())))
}

/** An installed pnpm 10 on `path`, outside `exclude` (Fig's own script directory). Another major is passed over:
 * the script then runs the pinned one, as DSH 0.2.2 expects pnpm 10. */
export async function installedPnpm(path: string, exclude: string): Promise<string | undefined> {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    if (resolve(directory) === resolve(exclude)) continue
    const candidate = join(directory, 'pnpm')
    try { await access(candidate, constants.X_OK) } catch { continue }
    const real = await realpath(candidate).catch(() => undefined)
    if (real && (await versionOf(real))?.startsWith(pnpmVersion.split('.')[0] + '.')) return real
  }
  return undefined
}

/** Writes `pnpm` into `directory` (only when it changed) and returns the directory to put first on PATH. */
export async function pnpmShim(npx: string, directory: string, path: string): Promise<string> {
  const file = join(directory, 'pnpm'), script = pnpmScript(npx, await installedPnpm(path, directory))
  await mkdir(directory, { recursive: true })
  // Every Fig on this Mac shares the script; replace it whole so no DSH runs a half-written one.
  if (await readFile(file, 'utf8').catch(() => '') !== script) {
    const temporary = file + '.' + process.pid
    await writeFile(temporary, script, { mode: 0o755 })
    await rename(temporary, file)
  }
  await chmod(file, 0o755)
  return directory
}

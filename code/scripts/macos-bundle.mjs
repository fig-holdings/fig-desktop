import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

// Bundle edits shared by the development host and the trial package. Local ad-hoc signatures only:
// no Developer ID, keychain, notarization or publication.

const run = (command, args) => execFileSync(command, args, { stdio: 'pipe' })

/** Sets each key of an Info.plist, adding string keys that do not exist yet. */
export function setPlist(path, entries) {
  for (const [key, value] of Object.entries(entries)) {
    try { run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, path]) }
    catch { run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, path]) }
  }
}

/** Removes extended attributes such as FinderInfo, which strict signature checks reject. */
export function clearAttributes(path) {
  run('/usr/bin/xattr', ['-cr', path])
}

export function adHocSign(path, identifier) {
  run('/usr/bin/codesign', ['--force', '--sign', '-', ...(identifier ? ['--identifier', identifier] : []), path])
}

export function verifySignature(path, strict = true) {
  run('/usr/bin/codesign', ['--verify', '--deep', ...(strict ? ['--strict'] : []), path])
}

/**
 * The Electron helper apps in a bundle's Frameworks folder whose name starts with `prefix`, each
 * with the bundle-ID suffix Electron's own naming implies: `main`, or `gpu`, `renderer`, `plugin`.
 */
export async function helperApps(bundle, prefix) {
  const frameworks = join(bundle, 'Contents/Frameworks')
  return (await readdir(frameworks))
    .filter(entry => entry.startsWith(prefix + ' Helper') && entry.endsWith('.app'))
    .map(entry => ({
      path: join(frameworks, entry),
      name: entry.slice(0, -4),
      suffix: entry.match(/\(([^)]+)\)/)?.[1].toLowerCase() ?? 'main'
    }))
}

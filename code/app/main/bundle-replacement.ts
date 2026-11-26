import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Packaging swaps the trial bundle in place while Fig runs, and the new version takes effect at the next launch
 * (code/README.md). This process already holds its own code, but whatever it would read from the bundle path
 * afterwards — DSH's plugin packages, patches, the skill folder — is the new version's, so it must not start DSH again.
 * Returns the version now at the bundle path when it is not the running one.
 */
export async function replacedVersion(appPath: string, running: string): Promise<string | undefined> {
  const version = await readFile(join(appPath, 'package.json'), 'utf8').then(text => JSON.parse(text).version, () => undefined)
  return typeof version === 'string' && version !== running ? version : undefined
}

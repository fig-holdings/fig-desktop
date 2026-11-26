import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workbenchPage } from '../../scripts/isolated-fig.mjs'

/** `work/verification/<name>/`, created; `--evidence=<path>` on the command line overrides it. */
export async function evidenceDir(name) {
  const dir = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
    ?? fileURLToPath(new URL(`../../../work/verification/${name}/`, import.meta.url))
  await mkdir(dir, { recursive: true })
  return dir
}

/** Writes `data` as indented JSON to `<evidence>/<file>`. */
export const writeResult = (evidence, data, file = 'result.json') => writeFile(join(evidence, file), JSON.stringify(data, null, 2) + '\n')

/**
 * The web Profile patch for an isolated Profile: its documents folder as the Workspace and the given
 * test fixtures inserted as plugins. `probes` lists fixture names (the id is the name) or maps ids to fixture names.
 */
export function insertProbes(state, probes) {
  const entries = Array.isArray(probes) ? probes.map(id => [id, id]) : Object.entries(probes)
  return writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
    { id: 'workspace-controller', config: { documentsDirectory: state.documents } },
    { insert: entries.map(([id, fixture]) => ({ id, name: fileURLToPath(new URL(`../fixtures/${fixture}.mjs`, import.meta.url)) })) }]))
}

/** The workbench page past the preview notice, with the composer ready. */
export async function openWorkbench(app, { timeout = 30_000 } = {}) {
  const page = await workbenchPage(app)
  await page.getByRole('button', { name: /^(Continue|继续)$/ }).click({ timeout })
  await page.locator('[data-lexical-editor="true"]').first().waitFor({ timeout })
  return page
}

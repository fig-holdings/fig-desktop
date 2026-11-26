import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { readJsonFile, writeRecord } from './atomic-json.ts'
import { dshHome } from './dsh-plugin.js'
import { workspaceInstructionsSource } from './message-sources.js'

const limit = 65_536
const maxSource = 1_048_576

/** The on/off setting for these ancestor instructions, in Fig's part of the DSH home. On unless switched off. */
export const instructionsSettingPath = (home = dshHome()) => join(home, 'fig', 'workspace-instructions.json')
/** Both switches in one read: the parent rules (`enabled`) and the short Harness guidance (`harnessGuidance`). */
export async function instructionSettings(path = instructionsSettingPath()) {
  const saved = await readJsonFile(path)
  return { enabled: saved?.enabled !== false, harnessGuidance: saved?.harnessGuidance !== false }
}
export async function instructionsEnabled(path = instructionsSettingPath()) {
  return (await instructionSettings(path)).enabled
}
export async function setInstructionsEnabled(enabled, path = instructionsSettingPath()) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
  const guidance = (await readJsonFile(path))?.harnessGuidance
  await writeRecord(path, {schema: 1, enabled, ...(typeof guidance === 'boolean' ? {harnessGuidance: guidance} : {})})
  return {enabled}
}
/** The short Harness guidance, in the same file: on unless `harnessGuidance` is false. No interface sets it; tests do. */
export async function harnessGuidanceEnabled(path = instructionsSettingPath()) {
  return (await instructionSettings(path)).harnessGuidance
}

/**
 * Ancestors omitted by DSH's nearest-Git-root discovery, only inside Fig's shared Workspace. `startup` comes from the
 * plugin's config; without one there are no shared instructions. A startup directory or ancestor that cannot be
 * resolved or read (removed, unmounted, no permission) degrades to no shared instructions with the reason named,
 * like the budget notice, instead of failing the turn.
 * @param {string} cwd @param {string | undefined} startup @param {boolean | Promise<boolean>} [enabled]
 */
export async function sharedInstructionsPlan(cwd, startup, enabled = instructionsEnabled()) {
  if (!startup || !await enabled) return {text: '', sections: [], cwd}
  try { return await readPlan(cwd, startup) } catch (error) {
    const {code, path} = /** @type {NodeJS.ErrnoException} */ (error)
    return {text: `\n\nWorkspace instructions unavailable: ${[code ?? 'unreadable', path].filter(Boolean).join(' ')}; no shared Workspace instructions were applied.`,
      sections: [], cwd}
  }
}

/** @param {string} cwd @param {string} startup */
async function readPlan(cwd, startup) {
  const [root, directory] = await Promise.all([realpath(startup), realpath(cwd)])
  const rel = relative(root, directory)
  if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep)) return {text: '', sections: [], cwd: directory}
  let nativeRoot = directory
  for (let probe = directory; ; probe = dirname(probe)) {
    if (await stat(join(probe, '.git')).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })) { nativeRoot = probe; break }
    if (probe === root) break
  }
  const ancestors = []
  for (let probe = dirname(nativeRoot); nativeRoot !== root; probe = dirname(probe)) {
    ancestors.unshift(probe)
    if (probe === root) break
  }
  const sections = []
  for (const ancestor of ancestors) {
    const path = join(ancestor, 'AGENTS.md')
    const metadata = await stat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (!metadata?.isFile()) continue
    sections.push({ path: await realpath(path), text: metadata.size > maxSource ? undefined : await readFile(path, 'utf8') })
  }
  return {...budgetedPlan(sections), cwd: directory}
}

const header = path => `\n\nInstructions from: ${path}\n`

/**
 * Fit the chain into the budget the way DSH's own instruction chain does: drop whole broader files first,
 * then truncate the most specific remaining file, and name what was left out instead of failing the turn.
 */
export function budgetedPlan(sections, max = limit) {
  const omitted = sections.filter(section => section.text === undefined).map(section => section.path)
  let kept = sections.filter(section => section.text !== undefined)
  const size = list => Buffer.byteLength(list.map(section => header(section.path) + section.text).join(''))
  const notice = (paths, truncated) => paths.length || truncated
    ? `\n\nWorkspace instruction budget: ${[...paths.map(path => 'omitted ' + path), ...(truncated ? ['truncated ' + truncated] : [])].join('; ')}.`
    : ''
  const dropped = new Set()
  while (kept.length > 1 && size(kept) + Buffer.byteLength(notice([...omitted, kept[0].path])) > max) {
    const first = kept.shift(); omitted.push(first.path); dropped.add(first)
  }
  let truncated, truncatedSource
  if (kept.length && size(kept) + Buffer.byteLength(notice(omitted)) > max) {
    const last = kept[0]
    truncated = last.path; truncatedSource = last
    const room = Math.max(0, max - Buffer.byteLength(header(last.path) + notice(omitted, truncated)))
    kept = [{ path: last.path, text: Buffer.from(last.text).subarray(0, room).toString('utf8').replace(/�$/, '') }]
  }
  return { text: kept.map(section => header(section.path) + section.text).join('') + notice(omitted, truncated),
    sections: sections.map(section => ({path: section.path,
      status: section.text === undefined ? 'omitted-size' : dropped.has(section) ? 'omitted-budget' : truncatedSource === section ? 'truncated' : 'included',
      contentDigest: section.text === undefined ? 'unknown' : createHash('sha256').update(section.text).digest('hex')})) }

}

/** Check the current model-visible surface, so compaction/resume cannot hide a cached snapshot. */
export const instructionDigest = plan => createHash('sha256').update(JSON.stringify({schema: 2, text: plan.text, sections: plan.sections, cwd: plan.cwd})).digest('hex')
export function instructionSnapshot(input, messages) {
  const plan = typeof input === 'string' ? {text: input, sections: [], cwd: undefined} : input
  const {text} = plan
  const digest = instructionDigest(plan)
  const previous = messages.findLast(message => message.source?.kind === workspaceInstructionsSource)
  if (previous?.source.digest === digest || (!previous && !text)) return undefined
  // Same framing as DSH's own workspace instructions, so shared rules carry the same (advisory) weight and
  // file content cannot close the frame.
  const body = (text || '\n\nNo shared Workspace instructions apply at the current directory.').replaceAll('</system-reminder>', '<\\/system-reminder>')
  // DSH 0.2.2-rc.5 refuses session events with undefined fields, so a snapshot without a directory leaves cwd out.
  return { source: { kind: workspaceInstructionsSource, schema: 2, version: 2, digest, sections: plan.sections, ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }) }, content: [{ type: 'text',
    text: '<system-reminder>\nShared Workspace instructions from directories above the project root, broad to specific. '
      + 'This snapshot replaces any earlier shared Workspace snapshot. More specific instructions, including the project instructions '
      + 'DSH loads from the project root down, take precedence. They do not override system, developer, or direct user instructions.'
      + body + '\n</system-reminder>' }] }
}

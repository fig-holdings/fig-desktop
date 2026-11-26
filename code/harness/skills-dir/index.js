import { isAbsolute } from 'node:path'
import { fromDsh } from '../shared/dsh-plugin.js'

// Registers one optional extra skill folder (config `directory`; Fig sets the one chosen in its Runtime settings), for every DSH session and model,
// without touching DSH's own skill roots. DSH's filesystem skill provider only scans the project's .dsh/skills and
// .agents/skills, the agent-preset bundle, and the DSH/agents homes; a folder of shared skills elsewhere (for example
// a Workspace's resources/skills) is covered by none of those. Rather than patch the preset-specific layers (the
// provider is registered per agent preset), Fig registers a SECOND filesystem provider with the official `ctx.skills`
// API, rooted at that folder. This is additive and preset-independent. With no folder set, nothing is registered.

export const name = 'fig-skills'
// The official filesystem skill provider only needs `ctx.skills`; it loads bodies through ctx.fs when present.
export const inject = ['skills']

/** The configured extra skill folder, when it is an absolute path. */
export function workspaceSkillsDir(folder) {
  return typeof folder === 'string' && isAbsolute(folder) ? folder : undefined
}

/** @param {any} ctx @param {{ directory?: string }} [config] */
export async function apply(ctx, config = {}) {
  const dir = workspaceSkillsDir(config?.directory)
  if (dir === undefined) {
    ctx.logger?.info?.('fig-skills: no extra skill folder set')
    return
  }
  // Reuse DSH's own filesystem skill provider so parsing, body loading and watching match the native one.
  // `includeDefaultRoots: false` keeps this provider to the chosen folder (plus the harmless, usually
  // absent project .dsh/.agents roots); DSH's primary provider still covers the default roots.
  const { apply: registerFilesystemSkills } = await fromDsh('@deepseek-ai/dsh-skill-filesystem')
  registerFilesystemSkills(ctx, {
    providerName: 'fig-workspace',
    includeDefaultRoots: false,
    customSkillDirs: [dir]
  })
  ctx.logger?.info?.(`fig-skills: extra skills from ${dir}`)
}

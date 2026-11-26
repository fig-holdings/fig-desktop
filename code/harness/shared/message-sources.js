// The `source.kind` of the messages Fig's packages put into a session before a step. The instructions package
// writes them and rule sources reads them back, so both name them from here.

/** Shared Workspace instructions (AGENTS.md files above the project root). */
export const workspaceInstructionsSource = 'fig-workspace-instructions'
/** Fig's short task guidance. */
export const harnessGuidanceSource = 'fig-harness-guidance'

// DSH Workspace registry entries as Fig's host plugins read them.

/** The registered Workspace with the longest path that is `directory` or contains it. */
export function containingWorkspace<W extends {path: string}>(workspaces: readonly W[], directory: string): W | undefined {
  return workspaces
    .filter(workspace => directory === workspace.path || directory.startsWith(workspace.path.endsWith('/') ? workspace.path : workspace.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

/** A Workspace's display name: the last segment of its path, or undefined for the root. */
export const workspaceName = (path: string): string | undefined => path.split('/').filter(Boolean).at(-1)

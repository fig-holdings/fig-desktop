import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { acceptedDsh } from '../dsh-versions'

// DSH has no default-workspace getter or setter, so Fig reads its on-disk registry
// (DSH_HOME/storages/workspace.json, unit `workspace` v2, as of DSH 0.2.2-rc.1). A local adaptation:
// only on a release Fig verified (or the candidate it started), and only when the whole file has the
// shape Fig knows. Re-check on each DSH upgrade (npm run dsh:verify).

export class WorkspaceFormatError extends Error {
  readonly code = 'WORKSPACE_FORMAT_UNSUPPORTED'
  constructor() { super('WORKSPACE_FORMAT_UNSUPPORTED') }
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

/** The parsed registry. Throws WorkspaceFormatError for an unverified release or an unknown shape, or the read error. */
export async function readWorkspaceRegistry(home: string, release: string | undefined) {
  if (release === undefined || !acceptedDsh.includes(release)) throw new WorkspaceFormatError()
  const path = join(home, 'storages/workspace.json')
  const raw = await readFile(path, 'utf8')
  const value = JSON.parse(raw), state = value.global, records = value.tables?.workspaces
  if (value.unit?.name !== 'workspace' || value.unit.version !== 2 || state?.initialized !== true || state.pendingMutation !== undefined ||
    !strings(state.workspaceIds) || new Set(state.workspaceIds).size !== state.workspaceIds.length || !records || Array.isArray(records) ||
    Object.values(records).some((r: any) => !r || typeof r.path !== 'string' || !isAbsolute(r.path) || typeof r.title !== 'string' || !strings(r.sessionIds) || typeof r.createdAt !== 'string' || typeof r.updatedAt !== 'string') ||
    state.workspaceIds.length !== Object.keys(records).length || state.workspaceIds.some((id: string) => !Object.hasOwn(records, id)) ||
    ['archivedSessionIds', 'pinnedSessionIds'].some(key => state[key] !== undefined && !strings(state[key]))) throw new WorkspaceFormatError()
  return {path, raw, value, state, records}
}

/** DSH's default Workspace path, or undefined when it cannot be read as above. */
export async function defaultWorkspacePath(home: string, release: string | undefined): Promise<string | undefined> {
  try {
    const {state, records} = await readWorkspaceRegistry(home, release)
    const id = state.defaultWorkspaceId
    return typeof id === 'string' && Object.hasOwn(records, id) ? records[id].path : undefined
  } catch { return undefined }
}

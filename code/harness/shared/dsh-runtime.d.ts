export const dshPackage: string
export function dshRuntimeRoot(home?: string): string
export interface DshRelease { version: string; digest: string }
export interface DshRuntimeLock { manifest: any; lock: any }
export function lockedRelease(manifest: any, lock: any): DshRelease
export function runtimeFolder(root: string, release: DshRelease): string
export function runtimeEntry(folder: string, version: string): string
export function installedRuntime(root: string, release: DshRelease): { folder: string; entry: string } | undefined
export function ensureDshRuntime(options: DshRuntimeLock & { root?: string; node: string; npm: string; env?: NodeJS.ProcessEnv; cache?: string;
  ignoreScripts?: boolean; signal?: AbortSignal; onInstall?: () => void }): Promise<{ folder: string; entry: string; version: string; installed: boolean }>
export function staleRuntimes(root: string, current: string, options?: { keep?: number; quietMs?: number; now?: number }): string[]
export function readRuntimeLock(folder: string): Promise<DshRuntimeLock>

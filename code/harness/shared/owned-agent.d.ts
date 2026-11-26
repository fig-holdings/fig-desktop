import type { ChildProcess } from 'node:child_process'
export function signalOwnedGroup(leader: ChildProcess, kind: NodeJS.Signals, kill?: typeof process.kill): void
export function runOwnedAgent(options: {file: string; args: string[]; cwd: string; input: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; nodeExecutable?: string; onOutput?: (kind: 'stdout' | 'stderr', chunk: string) => void}): Promise<{code: number | null; signal?: string; out: string; err: string; elapsedMs: number}>

// The task activity package's state as other packages and Fig's main process see it: the `figAttention` service
// (attention/index.js) and the projection shell-bridge serves to main (shell-bridge/bridge.ts, app/main/attention.ts).
// Shared here so no package imports another.

export const pendingKinds = ['approval', 'question', 'other'] as const
export type PendingKind = typeof pendingKinds[number]
export interface AttentionRow {
  sessionId: string; workspaceId?: string; running: boolean; pendingKinds: PendingKind[];
  lastSignificantAt: number; lastEventSeq?: number; turnId?: string; endReason?: string;
  pendingSince?: Partial<Record<PendingKind, number>>; unknownFailure?: boolean
}
export interface AttentionEvent { identity: string; sessionId: string; kind: PendingKind | 'failure' | 'result'; seq: number }
export interface AttentionSnapshot {
  schema: 1; generation: string; cursor: number; baseline: boolean; gap: boolean; synced: boolean;
  rows: AttentionRow[]; events: AttentionEvent[]; preferences: { schema: 1; notifications: boolean; dock: boolean }
}
export type DesktopAttentionSnapshot = Omit<AttentionSnapshot, 'rows'> & {rows: Pick<AttentionRow, 'sessionId' | 'running' | 'pendingKinds' | 'unknownFailure'>[]; running: boolean}

/** The `figAttention` service the task activity package provides. */
export interface FigAttention {
  /** Rows, events after `cursor` and preferences, as the package's own page reads them. */
  read: (cursor?: number) => AttentionSnapshot;
  /** Whether no Session or background job is running; asked before a native directory change. */
  idle: () => Promise<boolean>;
}

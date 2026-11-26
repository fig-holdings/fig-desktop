// GitHub check runs and legacy commit statuses share one presentation contract.
export function safeCheckUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined } catch { return undefined }
}
export function normalizeCheck(check) {
  const legacy = check?.__typename === 'StatusContext' || Object.hasOwn(check ?? {}, 'state')
  const status = String(legacy ? check.state : check?.status ?? '').toUpperCase()
  const conclusion = String(check?.conclusion ?? '').toUpperCase()
  let state = 'unknown'
  if (legacy) state = status === 'SUCCESS' ? 'passed' : ['FAILURE', 'ERROR'].includes(status) ? 'failed' : ['PENDING', 'EXPECTED'].includes(status) ? 'queued' : 'unknown'
  else if (status === 'IN_PROGRESS') state = 'running'
  else if (['QUEUED', 'WAITING', 'PENDING', 'REQUESTED'].includes(status)) state = 'queued'
  else if (status === 'COMPLETED') state = ({ SUCCESS: 'passed', FAILURE: 'failed', TIMED_OUT: 'timed-out', CANCELLED: 'cancelled', SKIPPED: 'skipped', NEUTRAL: 'neutral', ACTION_REQUIRED: 'action-required', STALE: 'stale' })[conclusion] ?? 'unknown'
  return { name: String(check?.name ?? check?.context ?? 'Check'), state,
    url: safeCheckUrl(check?.detailsUrl ?? check?.targetUrl), startedAt: check?.startedAt ?? null, completedAt: check?.completedAt ?? null }
}
export const activeCheck = check => ['running', 'queued', 'unknown'].includes(check.state)
export const failedCheck = check => ['failed', 'timed-out', 'action-required', 'stale'].includes(check.state)
/** A finished check that does not hold a merge back. */
export const okCheck = check => ['passed', 'skipped', 'neutral'].includes(check.state)
export function ciSummary(checks) {
  return { total: checks.length, completed: checks.filter(c => !activeCheck(c)).length,
    running: checks.filter(c => c.state === 'running').length, queued: checks.filter(c => c.state === 'queued').length,
    failed: checks.filter(failedCheck).length, unknown: checks.filter(c => c.state === 'unknown').length }
}
export function pollDelay(value, error) {
  if (error || value?.problem) return 60_000
  return [...(value?.session ?? []), ...(value?.pulls ?? [])].some(p => p.open !== false && p.checks?.some(activeCheck)) ? 15_000 : 120_000
}

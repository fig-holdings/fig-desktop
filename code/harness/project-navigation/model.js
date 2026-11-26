// Project identity is deliberately independent of task success and notification preferences.
import { colors, icons } from '../shared/project-appearance.js'
export { colors, icons }
export function validAppearance(value) {
  return value && Object.hasOwn(icons, value.icon) && Object.hasOwn(colors, value.color)
}
export function projectFor(id, workspaces) {
  return workspaces.items.find(item => item.sessionIds.includes(id))
}
export function sessionState(summary, statuses, list) {
  const status = statuses.get(summary.id)
  if (status?.pendingInteraction) return 'waiting'
  const children = list.projectionsBySession?.[summary.id]?.values?.subagentCatalog ?? []
  if ((status?.running ?? summary.running) || children.some(child => statuses.get(child.id)?.running ?? list.byId[child.id]?.running)) return 'running'
  return 'idle'
}
export function recentSessions(list, workspaces) {
  const archived = new Set(workspaces.archivedSessionIds)
  return Object.values(list.byId).filter(s => !s.blank && s.origin !== 'subagent' && !archived.has(s.id))
    .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 10)
}
function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(value) || 0
}

import { t } from './client-locale.js'
import { openSessionId, slotFace } from '../shared/dsh-internals.js'
import { orderedRegistry } from '../shared/ordered-registry.js'

// Sections in the new session's workspace picker, offered to other page plugins as the `figWorkspacePicker` service.
// A claimed task is a project and a project is a workspace, so a team plugin lists the tasks here: picking one switches to its workspace and puts the
// task into the input as a draft, through DSH's public `uiWorkspace.startSession`. Nothing here knows about tasks.
//
//   const handle = ctx.figWorkspacePicker.register({ id: 'claims', title: '我认领的任务', items: [...], onPicked })
//   handle.update({ items, selectedItemId }); handle.dispose()
//
// An item: { id, label, detail?, workspaceId?, draft?, disabled? }. With `workspaceId` picking it starts (or reuses) that
// workspace's blank session and adds `draft` to its input, never sending it. Without one, Fig asks for a local folder
// (DSH's own folder picker), adds it as a workspace, tells the section through `onWorkspaceAdded(item, workspaceId)`
// and continues the same way. `onPicked(item, { workspaceId, sessionId })` follows; `sessionId` is the blank session
// the draft went into, when it could be read.
//
// DSH's picker is a single-occupant slot (`conversation.hero.workspace`) and cannot take extra rows, so while any
// section is registered Fig occupies the slot with one menu: the sections, then the workspaces, then 「添加工作区…」.
// With no section the slot is left to DSH untouched. Re-check on each DSH upgrade (npm run dsh:verify).

export const version = 1

export function workspacePickerSections() {
  const registry = orderedRegistry()
  return {
    version,
    register(entry) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) throw new TypeError('figWorkspacePicker.register: id is required')
      return registry.add(entry.id, { order: 0, items: [], ...entry }, { id: entry.id })
    },
    subscribe: registry.subscribe,
    getSnapshot: registry.getSnapshot,
    list: () => registry.list()
  }
}

/** Menu row ids: a section item is `<section>\u0000<item>`, so it never collides with a workspace id. */
const itemKey = (section, item) => section + '\u0000' + item
const headerKey = section => '\u0000header\u0000' + section
const addKey = '\u0000add'

/**
 * Occupies the hero workspace slot while `sections` has any registration.
 * @param {typeof import('react')} react
 */
export function installWorkspacePicker(ctx, react, primitives, sections) {
  const { createElement: h, useSyncExternalStore } = react
  const { Menu, IconFolderCloseRegular, IconPlusOutlineRegular, IconCheckOutlineRegular } = primitives
  const slot = 'conversation.hero.workspace'
  // DSH's own occupant: its injected face has the workspace list and `createWorkspace`.
  const face = () => slotFace(ctx, slot, entry => entry.component !== Picker)

  async function waitForSession(previous) {
    for (let i = 0; i < 30; i++) {
      const id = openSessionId()
      if (id && id !== previous) return id
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return openSessionId()
  }

  async function pickItem(section, item, onPick) {
    let workspaceId = item.workspaceId
    if (!workspaceId) {
      const path = await ctx.uiWorkspace.pickDirectory?.()
      const create = face()?.createWorkspace
      if (!path || typeof create !== 'function') return
      workspaceId = (await create({ path })).workspaceId
      section.onWorkspaceAdded?.(item, workspaceId)
    }
    const previous = openSessionId()
    onPick(workspaceId)
    ctx.uiWorkspace.startSession(workspaceId, typeof item.draft === 'string' && item.draft ? { prompt: item.draft, whenDraftExists: 'append' } : undefined)
    section.onPicked?.(item, { workspaceId, sessionId: await waitForSession(previous) })
  }

  function Picker(props) {
    useSyncExternalStore(sections.subscribe, sections.getSnapshot)
    const useWorkspaces = props.useWorkspaces ?? face()?.useWorkspaces
    const workspaces = useWorkspaces ? useWorkspaces(state => state.items) ?? [] : []
    const groups = sections.list()
    const items = []
    let selectedId = props.selectedId
    for (const section of groups) {
      items.push({ id: headerKey(section.id), label: h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, section.title ?? section.id), disabled: true })
      for (const item of section.items ?? []) {
        if (section.selectedItemId === item.id) selectedId = itemKey(section.id, item.id)
        items.push({ id: itemKey(section.id, item.id), disabled: item.disabled === true,
          icon: section.selectedItemId === item.id ? h(IconCheckOutlineRegular, { size: 16 }) : h('span', { style: { display: 'inline-block', width: 16 } }),
          label: h('span', { 'data-fig-picker-item': item.id, style: { display: 'inline-flex', gap: 8, minWidth: 0 } },
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.label),
            item.detail && h('span', { style: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, item.detail),
            !item.workspaceId && !item.disabled && h('span', { style: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, t('workspace-picker.chooseALocalFolder'))) })
      }
    }
    items.push({ id: headerKey('workspaces'), label: h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('workspace-picker.workspaces')), disabled: true })
    // As DSH's picker names them: its default workspace by the localized name, same-titled ones with their path's end.
    const title = workspace => workspace.title === 'default-workspace' || !workspace.title ? t('workspace-picker.defaultWorkspace') : workspace.title
    for (const workspace of workspaces) {
      const twins = workspaces.filter(other => other !== workspace && title(other) === title(workspace))
      const tail = twins.length ? String(workspace.path ?? '').split('/').slice(-2).join('/') : undefined
      items.push({ id: workspace.workspaceId, icon: h(IconFolderCloseRegular, { size: 16 }),
        label: tail ? h('span', { title: workspace.path }, title(workspace), ' ', h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, tail)) : title(workspace) })
    }
    const onSelect = id => {
      props.onClose()
      if (id === addKey) {
        void ctx.uiWorkspace.pickDirectory?.().then(async path => {
          const create = face()?.createWorkspace
          if (path && typeof create === 'function') props.onPick((await create({ path })).workspaceId)
        }).catch(error => console.error('[fig-workspace-picker]', error))
        return
      }
      const [sectionId, itemId] = id.split('\u0000')
      const section = itemId !== undefined && groups.find(item => item.id === sectionId)
      const item = section && section.items?.find(entry => entry.id === itemId)
      if (section && item) void pickItem(section, item, props.onPick).catch(() => {})
      else if (!id.startsWith('\u0000')) props.onPick(id)
    }
    return h(Menu, { open: props.open, anchor: null, items, footer: [{ id: addKey, label: t('workspace-picker.addWorkspace'), icon: h(IconPlusOutlineRegular, { size: 16 }) }],
      selectedId, onSelect, onClose: props.onClose, side: 'bottom', portal: true,
      getAnchorRect: () => props.anchorRef?.current?.getBoundingClientRect() ?? null })
  }

  let registration
  const sync = () => {
    const wanted = sections.list().length > 0
    if (wanted && !registration) registration = ctx.slots.register({ name: slot, priority: -100 }, Picker)
    else if (!wanted && registration) { if (typeof registration === 'function') registration(); else registration?.dispose?.(); registration = undefined }
  }
  const stop = sections.subscribe(sync)
  sync()
  return () => { stop(); if (typeof registration === 'function') registration(); else registration?.dispose?.(); registration = undefined }
}

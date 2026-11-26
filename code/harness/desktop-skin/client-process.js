import { slotFace } from '../shared/dsh-internals.js'
import { pageRpc } from '../shared/page-rpc.js'

// DSH 0.2.2-rc.1's Web default is detailed (live rows expanded). Standard already provides
// collapsed live process groups, current-tool summaries, and independent user disclosure.
// Keep the native state machine: never hide approvals, questions, errors or assistant replies in CSS.
// Apply once per browser Profile; later choices in DSH's Work steps settings remain the user's.
export function installProcessDefault(ctx, rpc = pageRpc('/fig-skin')) {
  let applied = false, ready = false, disposed = false
  const apply = () => {
    if (applied || !ready || disposed) return
    const face = slotFace(ctx, 'settings.general.item', entry => entry.options?.id === 'transcript-view', {
      accept: face => typeof face?.setTranscriptView === 'function' && Boolean(face.hooks?.transcriptView)
    })
    if (!face) return
    applied = true
    face.setTranscriptView('standard')
    void rpc('process/default-applied').catch(error => console.warn('[fig-process] preference marker could not be saved', error))
  }
  const off = ctx.on('slots/changed', key => { if (key === 'settings.general.item') apply() })
  void rpc('process/default-state').then(state => {
    if (disposed) return
    applied = state.applied === true
    ready = true
    apply()
  }).catch(error => console.warn('[fig-process] preference state unavailable; native settings retained', error))
  return () => { disposed = true; if (typeof off === 'function') off() }
}

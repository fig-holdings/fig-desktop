import test from 'node:test'
import assert from 'node:assert/strict'
import { installProcessDefault } from '../harness/desktop-skin/client-process.js'

test('native standard process default applies once per host Profile, waits for registration, then preserves choices', async () => {
  let saved = false, available = false, changed, mode = 'detailed', calls = 0, disposed = false
  const face = { hooks: { transcriptView: {} }, setTranscriptView: value => { mode = value; calls++ } }
  const ctx = { slots: { entries: () => available ? [{ options: { id: 'transcript-view' }, inject: () => face }] : [] }, on: (_event, run) => { changed = run; return () => { disposed = true } } }
  const rpc = async endpoint => { if (endpoint.endsWith('applied')) { saved = true; return true }; return { applied: saved } }
  const stop = installProcessDefault(ctx, rpc)
  await Promise.resolve(); assert.equal(calls, 0)
  available = true; changed('settings.general.item')
  assert.equal(mode, 'standard'); assert.equal(calls, 1); assert.equal(saved, true)
  mode = 'verbose'; changed('settings.general.item'); assert.equal(mode, 'verbose')
  stop(); assert.equal(disposed, true)
  const nextStop = installProcessDefault(ctx, rpc); await Promise.resolve(); nextStop()
  assert.equal(mode, 'verbose'); assert.equal(calls, 1)
})

test('unmount before preference read never writes or changes mode', async () => {
  let resolve, writes = 0
  const pending = new Promise(done => { resolve = done })
  const stop = installProcessDefault({ on: () => () => {}, slots: { entries: () => { throw new Error('must not inspect disposed slots') } } }, () => { writes++; return pending })
  stop(); resolve({ applied: false }); await Promise.resolve(); assert.equal(writes, 1)
})

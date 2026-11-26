import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fresh folder under `base` (the system temp folder by default), removed when test `t` ends. */
export async function tempDir(t, prefix, base = tmpdir()) {
  const path = await mkdtemp(join(base, prefix))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

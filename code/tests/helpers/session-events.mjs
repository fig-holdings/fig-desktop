import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Every event in the isolated DSH session logs, which are concatenated zstd frames. */
export async function sessionEvents(root) {
  const events = []
  for (const entry of await readdir(root, { recursive: true }).catch(() => [])) {
    if (!entry.endsWith('.jsonl.zstd')) continue
    const bytes = await readFile(join(root, entry))
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const starts = []
    for (let at = 0; (at = bytes.indexOf(magic, at)) !== -1; at += 4) starts.push(at)
    starts.push(bytes.length)
    let text = ''
    for (let from = 0, next = 1; next < starts.length; next++) {
      // A magic number can also occur inside compressed data; extend the frame until it decodes.
      try { text += zstdDecompressSync(bytes.subarray(starts[from], starts[next])); from = next } catch {}
    }
    for (const line of text.split('\n')) if (line) try { events.push(JSON.parse(line)) } catch {}
  }
  return events
}

import { open } from 'node:fs/promises'

/** The last `length` bytes of the file as text; the first line may be partial. */
export async function tail(path, length) {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const count = Math.min(size, length)
    const buffer = Buffer.alloc(count)
    await file.read(buffer, 0, count, size - count)
    return { text: buffer.toString('utf8'), whole: count === size }
  } finally {
    await file.close()
  }
}

/**
 * The newest match in a log read from its end: `find` gets whole lines only, newest last, from a window
 * that grows from `length` bytes until it finds a match or covers the file. Same result as reading the
 * whole file, which a large log is spared.
 */
export async function findInTail(path, find, length = 256 * 1024) {
  for (let window = length; ; window *= 4) {
    const { text, whole } = await tail(path, window)
    const found = find(whole ? text : text.slice(text.indexOf('\n') + 1))
    if (found !== undefined || whole) return found
  }
}

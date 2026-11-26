import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Parsed JSON at `path`, or undefined when it is missing or unreadable. Never moves the file, so it suits files Fig does not own. */
export async function readJsonFile(path: string): Promise<any> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined }
}

/** One writer per file; a malformed file is preserved, never silently overwritten. */
export async function readRecord<T>(path: string, valid: (value: any) => value is T, fallback: T): Promise<T> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!valid(value)) throw new Error('invalid schema')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await rename(path, path + '.corrupt-' + randomUUID())
    return fallback
  }
}
/** Write JSON through a uniquely named owner-only temporary file, so a reader never sees half of it. */
export async function writeRecord(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}

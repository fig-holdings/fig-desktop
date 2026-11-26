import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

// 提交…: the workbench lists the changed files and, once the user picks some, asks the Session's Agent to commit exactly
// those. The plugin never writes to git itself: the Agent runs `git add` and `git commit` through its bash tool under
// the Session's usual approval, where the user also reviews the message it drafted. Design: discussion round 10.

/**
 * `git status --porcelain=v1 -z --untracked-files=all` as entries. A rename or copy prints the new path, then the
 * old one as its own field.
 * @param {string} text
 */
export function parseStatus(text) {
  const fields = text.split('\0')
  const entries = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    if (field.length < 4) continue
    const x = field[0], y = field[1], path = field.slice(3)
    const staged = x !== ' ' && x !== '?' && x !== '!'
    // Staged and changed again in the work tree: `git commit -- <path>` takes the whole file as it is now, unstaged part
    // included, so the dialog says so.
    const entry = { path, index: x, worktree: y, untracked: x === '?', staged, partial: staged && (y === 'M' || y === 'D'),
      deleted: x === 'D' || y === 'D', renamed: x === 'R' || x === 'C', ...(x === 'R' || x === 'C' ? { from: fields[++index] } : {}) }
    // A rename in the work tree (" R", after `git add -N`) also prints the old path as its own field.
    if (!entry.renamed && (y === 'R' || y === 'C')) index++
    if (x === '!') continue
    entries.push(entry)
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * A fingerprint of the changed files: their status plus each file's size and modification time, so an edit to an
 * already-modified file also changes it. @param {string} root @param {string} porcelain @param {{ path: string }[]} entries
 */
export async function fingerprint(root, porcelain, entries) {
  const hash = createHash('sha256').update(porcelain)
  for (const entry of entries) {
    const info = await stat(resolve(root, entry.path)).catch(() => undefined)
    hash.update('\0' + entry.path + '\0' + (info ? `${info.size}:${info.mtimeMs}` : 'gone'))
  }
  return hash.digest('hex')
}

/** A path the picked list may hold: relative, inside the checkout. @param {string} root @param {unknown} path */
export function insideCheckout(root, path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return false
  const inside = relative(root, resolve(root, path))
  return Boolean(inside) && !inside.startsWith('..' + sep) && inside !== '..' && !isAbsolute(inside)
}

const CONTROL = /[\0-\x1f\x7f]/

/**
 * A path for the instruction: single-quoted for the shell when it holds anything but plain characters, and in `$'…'`
 * with escapes when it holds a line break or other control character, so a file name cannot add lines to the message.
 * @param {string} path
 */
export const shellPath = path => /^[\w@%+=:,./-]+$/.test(path) ? path
  : CONTROL.test(path) ? `$'${path.replace(/[\\']/g, '\\$&').replace(/[\0-\x1f\x7f]/g, char => '\\x' + char.charCodeAt(0).toString(16).padStart(2, '0'))}'`
    : `'${path.replace(/'/g, `'\\''`)}'`

/** A path as listed for the reader: JSON-escaped when it holds a control character. @param {string} path */
const listedPath = path => CONTROL.test(path) ? JSON.stringify(path) : path

/**
 * The message sent to the Session: commit exactly `picked` (entries from {@link parseStatus}), with a message the Agent
 * drafts; nothing else is staged, pushed or amended.
 * @param {{ path: string, untracked: boolean, deleted: boolean, renamed: boolean, from?: string }[]} picked
 * @param {{ root: string, branch: string | null, chinese: boolean, coAuthor?: string }} context
 */
export function commitInstruction(picked, { root, branch, chinese, coAuthor }) {
  const fresh = picked.filter(entry => entry.untracked).map(entry => shellPath(entry.path))
  // A rename commits both sides, so the old path leaves the index in the same commit.
  const all = picked.flatMap(entry => entry.renamed && entry.from ? [entry.from, entry.path] : [entry.path]).map(shellPath)
  const list = picked.map(entry => '- ' + listedPath(entry.path) + (entry.untracked ? (chinese ? '（新文件）' : ' (new file)')
    : entry.deleted ? (chinese ? '（删除）' : ' (deleted)') : entry.renamed ? (chinese ? `（由 ${listedPath(entry.from ?? '')} 重命名）` : ` (renamed from ${listedPath(entry.from ?? '')})`) : ''))
  const add = fresh.length ? `git add -- ${fresh.join(' ')}` : ''
  const commit = `git commit -m "<message>" -- ${all.join(' ')}`
  if (chinese) {
    return ['（来自研发工作台）请提交下面勾选的文件。', '', `仓库：${listedPath(root)}` + (branch ? `，分支：${branch}` : ''), '文件：', ...list, '',
      '要求：',
      '1. 只处理这些文件，不修改、不暂存其他任何文件。',
      '2. 先用只读命令（如 git diff -- <文件>）看这些文件的改动，按本仓库已有的提交信息风格起草一条简洁的提交信息。',
      ...(add ? [`3. 新文件先执行：${add}`] : []),
      `${add ? 4 : 3}. 然后执行：${commit}（把 <message> 换成你起草的信息；命令末尾列出文件，只提交这些文件，暂存区里的其他文件不会带进来）。`,
      ...coAuthor ? [`提交信息末尾空一行，再添加提交尾注 ${coAuthor}。`] : [],
      `${add ? 5 : 4}. 不要 push，不要 amend，不要改动其他提交。完成后报告提交的哈希和提交信息；如果任何一步失败，停下并说明原因，不要自行改用其他做法。`
    ].join('\n')
  }
  return ['(From the development workbench) Please commit the files picked below.', '', `Repository: ${listedPath(root)}` + (branch ? `, branch: ${branch}` : ''), 'Files:', ...list, '',
    'Requirements:',
    '1. Touch only these files; do not modify or stage anything else.',
    '2. First read their changes with read-only commands (such as git diff -- <file>) and draft a concise commit message in the style this repository already uses.',
    ...(add ? [`3. Stage the new files: ${add}`] : []),
    `${add ? 4 : 3}. Then run: ${commit} (replace <message> with your draft; the paths at the end limit the commit to these files, leaving anything else in the index out).`,
    ...coAuthor ? [`End the commit message with a blank line, then the trailer ${coAuthor}.`] : [],
    `${add ? 5 : 4}. Do not push, amend or change other commits. Report the commit hash and message when done; if a step fails, stop and say why instead of trying another way.`
  ].join('\n')
}

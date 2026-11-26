// git diff patches for the 研发工作台's 代码变更 and PR review tabs: files, hunks and numbered lines, ready for the page.
// Paths come from git's own a/ and b/ prefixes, C-quoted when they need escaping.

/** Lines a single file may draw before it is cut; the page says how many were left out. */
export const MAX_FILE_LINES = 3000

/** git's C-style quoted path ("a\tb") to text; unquoted paths pass through. @param {string} value */
export function unquotePath(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  const bytes = []
  const body = value.slice(1, -1)
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char !== '\\') { bytes.push(...Buffer.from(char)); continue }
    const next = body[++index]
    if (/[0-7]/.test(next)) { bytes.push(parseInt(body.slice(index, index + 3), 8)); index += 2; continue }
    bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 })[next] ?? next.charCodeAt(0))
  }
  return Buffer.from(bytes).toString('utf8')
}

const stripPrefix = (path, prefix) => {
  const plain = unquotePath(path)
  return plain.startsWith(prefix) ? plain.slice(prefix.length) : plain
}

/**
 * The path on a `diff --git a/<path> b/<path>` line. Without a rename both sides are equal, so an unquoted line splits
 * at its middle even when the path holds " b/"; renames are refined by their own lines.
 * @param {string} rest the line after "diff --git "
 */
function diffGitPath(rest) {
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest.startsWith('a/') && rest.slice(half, half + 3) === ' b/' && rest.slice(2, half) === rest.slice(half + 3)) {
    return rest.slice(2, half)
  }
  const match = /^(?:"a\/.*?"|a\/.*?) ("b\/.*"|b\/.*)$/.exec(rest)
  return match ? stripPrefix(match[1], 'b/') : rest
}

/**
 * A `git diff` patch (a/ and b/ prefixes) as files with hunks of lines, ready for the page.
 * @param {string} patch
 */
export function parsePatch(patch) {
  /** @type {any[]} */
  const files = []
  /** @type {any} */
  let file
  /** @type {any} */
  let hunk
  let oldLine = 0, newLine = 0
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // The new side: `b/...`, or a C-quoted `"b/..."` when the path needs escaping. +++ and rename lines refine it.
      file = { path: diffGitPath(raw.slice(11)), oldPath: undefined, status: 'modified', binary: false, added: 0, deleted: 0, lines: 0, truncated: 0, hunks: [] }
      files.push(file)
      hunk = undefined
      continue
    }
    if (!file) continue
    if (!hunk) {
      if (raw.startsWith('new file mode')) file.status = 'added'
      else if (raw.startsWith('deleted file mode')) file.status = 'deleted'
      else if (raw.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = unquotePath(raw.slice(12)) }
      else if (raw.startsWith('rename to ')) file.path = unquotePath(raw.slice(10))
      else if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') file.binary = true
      else if (raw.startsWith('+++ ') && raw !== '+++ /dev/null') file.path = stripPrefix(raw.slice(4), 'b/')
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw)
    if (header) {
      hunk = { header: raw, lines: [] }
      file.hunks.push(hunk)
      oldLine = Number(header[1]); newLine = Number(header[2])
      continue
    }
    if (!hunk) continue
    const kind = raw[0]
    if (kind !== '+' && kind !== '-' && kind !== ' ') continue // "\ No newline at end of file"
    if (kind === '+') file.added++
    if (kind === '-') file.deleted++
    if (file.lines >= MAX_FILE_LINES) { file.truncated++; continue }
    file.lines++
    hunk.lines.push(kind === '+' ? { kind, text: raw.slice(1), new: newLine++ }
      : kind === '-' ? { kind, text: raw.slice(1), old: oldLine++ }
        : { kind, text: raw.slice(1), old: oldLine++, new: newLine++ })
  }
  for (const each of files) delete each.lines
  return files
}

// Whether a DSH release satisfies a plugin's `engines.dsh` range. External plugins (app/main/external-plugins.ts) are
// checked against the release Fig starts before they are installed. Only the npm range forms a plugin manifest
// realistically uses are accepted: exact versions, comparators (=, >, >=, <, <=), caret and tilde, `*`, and `||`
// alternatives of space-separated comparator sets. Prerelease ordering follows SemVer; as in npm, a prerelease only
// matches a comparator set that names a prerelease of the same major.minor.patch.

/** A plain DSH release version, as Fig pins one (`0.2.2` or `0.2.2-rc.1`): no `v`, no range, no build metadata. */
export const dshReleasePattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

type Version = { major: number, minor: number, patch: number, pre: (string | number)[] }

const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(value: string): Version | undefined {
  const match = versionPattern.exec(value.trim())
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    pre: match[4] ? match[4].split('.').map(part => /^\d+$/.test(part) ? Number(part) : part) : [] }
}

export function compareVersions(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

type Comparator = { op: '<' | '<=' | '>' | '>=' | '=', version: Version }

/** One comparator token as a list of plain comparators, or undefined when it is not a supported form. */
function expand(token: string): Comparator[] | undefined {
  if (token === '*' || token === 'x') return []
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token)
  const version = match && parseVersion(match[2])
  if (!match || !version) return undefined
  const op = match[1] ?? '='
  const bump = (major: number, minor: number, patch: number): Version => ({ major, minor, patch, pre: [0] })
  if (op === '^') {
    const upper = version.major > 0 ? bump(version.major + 1, 0, 0)
      : version.minor > 0 ? bump(0, version.minor + 1, 0) : bump(0, 0, version.patch + 1)
    return [{ op: '>=', version }, { op: '<', version: upper }]
  }
  if (op === '~') return [{ op: '>=', version }, { op: '<', version: bump(version.major, version.minor + 1, 0) }]
  return [{ op: op as Comparator['op'], version }]
}

function test(comparator: Comparator, version: Version): boolean {
  const order = compareVersions(version, comparator.version)
  switch (comparator.op) {
    case '<': return order < 0
    case '<=': return order <= 0
    case '>': return order > 0
    case '>=': return order >= 0
    default: return order === 0
  }
}

/**
 * Whether `version` satisfies `range`. Returns undefined when the range uses a form this checker does not read, so
 * the caller can report it rather than guess.
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const target = parseVersion(version)
  if (!target) return undefined
  let readable = true
  const matched = range.split('||').some(alternative => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean)
    const comparators = tokens.map(expand)
    if (comparators.some(item => item === undefined)) { readable = false; return false }
    const set = (comparators as Comparator[][]).flat()
    if (target.pre.length && !set.some(item => item.version.pre.length && item.version.major === target.major
      && item.version.minor === target.minor && item.version.patch === target.patch)) return false
    return set.every(item => test(item, target))
  })
  return matched ? true : readable ? false : undefined
}

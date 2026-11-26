import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { GIT_ENV } from '../../harness/development-workbench/git.js'
import { tempDir } from './temp-dir.mjs'

/** The GitHub origin the workbench fixtures pretend to come from. */
export const FIXTURE_REMOTE = 'https://github.com/fig-fixture/app.git'

/** git's environment for fixtures: the workbench's own GIT_ENV (inherited repository overrides dropped) and a fixed author. */
export const FIXTURE_GIT_ENV = (() => {
  const env = { ...process.env }
  for (const [key, value] of Object.entries(GIT_ENV)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
})()

/** Runs git in `cwd` with the fixture environment and returns its output. */
export const fixtureGit = cwd => (...args) => execFileSync('git', args, { cwd, env: FIXTURE_GIT_ENV }).toString()

/**
 * `git init -b main` in `dir` (created if missing). `remote: true` adds the GitHub fixture origin,
 * a string adds that origin, nothing adds none. Returns the repository's `git`.
 */
export async function initRepo(dir, { remote } = {}) {
  await mkdir(dir, { recursive: true })
  const git = fixtureGit(dir)
  git('init', '-q', '-b', 'main')
  if (remote) git('remote', 'add', 'origin', remote === true ? FIXTURE_REMOTE : remote)
  return git
}

/** A fresh repository in a temporary folder removed when test `t` ends: `{ root, git }`. */
export async function fixtureRepo(t, { remote, prefix = 'fig-git-' } = {}) {
  const root = await tempDir(t, prefix)
  return { root, git: await initRepo(root, { remote }) }
}

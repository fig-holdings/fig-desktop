import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AUTOFIX_LIMIT, autofixStep, fixInstruction, fixKinds, mergeInstruction, mergeReady, parsePullUrl, pullRequestInstruction, pushInstruction, safeBranch }
  from '../harness/development-workbench/actions.js'
import { sessionPullUrls } from '../harness/development-workbench/outputs.js'
import { formatLineComment } from '../harness/development-workbench/client-diff.js'
import { gitRunner, readRepository } from '../harness/development-workbench/git.js'
import { branchState } from '../harness/development-workbench/index.js'
import { fixtureGit, initRepo } from './helpers/git-fixture.mjs'
import { tempDir } from './helpers/temp-dir.mjs'

const URL = 'https://github.com/me/app/pull/12'
const failed = { name: 'build', state: 'failed', url: 'https://github.com/me/app/actions/runs/1' }

test('push and pull request instructions: exact commands, no force, stop on rejection', () => {
  const push = pushInstruction({ root: '/r', branch: 'feat/x', upstream: 'origin/feat/x', chinese: true })
  assert.match(push, /执行：git push\n/)
  assert.match(push, /不要 force push/)
  assert.match(pushInstruction({ root: '/r', branch: 'feat/x', upstream: null, chinese: false }), /Run: git push -u origin feat\/x/)
  const pr = pullRequestInstruction({ root: '/r', branch: 'feat/x', base: 'main', draft: true, pushed: false, upstream: null, chinese: true })
  assert.match(pr, /git push -u origin feat\/x/)
  assert.match(pr, /gh pr create --base main --head feat\/x --draft --title "<title>" --body "<body>"/)
  assert.match(pr, /不要合并/)
  assert.doesNotMatch(pullRequestInstruction({ root: '/r', branch: 'feat/x', base: 'main', draft: false, pushed: true, upstream: 'origin/feat/x', chinese: false }), /git push|--draft/)
  assert.equal(safeBranch('feat/x-1.2'), true)
  for (const bad of ['-x', 'a..b', 'a b', 'a;rm', 'x/', 'x.lock', '']) assert.equal(safeBranch(bad), false, bad)
  assert.deepEqual(parsePullUrl(URL), { owner: 'me', repo: 'app', number: 12, url: URL })
  assert.equal(parsePullUrl(URL + '/files'), undefined)
  assert.equal(parsePullUrl('https://evil.example/me/app/pull/1'), undefined)
})

test('fix and merge: what a pull request needs, when it may merge, and the locked merge command', () => {
  const pull = { url: URL, branch: 'feat', base: 'main', open: true, mergeable: 'MERGEABLE', reviewDecision: '', checks: [{ state: 'passed' }] }
  assert.deepEqual(fixKinds(pull), [])
  assert.deepEqual(fixKinds({ ...pull, mergeable: 'CONFLICTING', checks: [failed], reviewDecision: 'CHANGES_REQUESTED' }), ['conflict', 'ci', 'review'])
  assert.deepEqual(fixKinds({ ...pull, open: false, checks: [failed] }), [])
  assert.deepEqual(mergeReady(pull), { ok: true })
  assert.deepEqual(mergeReady({ ...pull, checks: [{ state: 'running' }] }), { ok: false, reason: 'checks' })
  assert.deepEqual(mergeReady({ ...pull, checks: [{ state: 'cancelled' }] }), { ok: false, reason: 'checks' })
  assert.deepEqual(mergeReady({ ...pull, draft: true }), { ok: false, reason: 'draft' })
  assert.deepEqual(mergeReady({ ...pull, mergeable: 'UNKNOWN' }), { ok: false, reason: 'unknown' })
  assert.deepEqual(mergeReady({ ...pull, reviewDecision: 'REVIEW_REQUIRED' }), { ok: false, reason: 'review' })
  const ci = fixInstruction({ pull: { ...pull, checks: [failed] }, kind: 'ci', root: '/r', chinese: true })
  assert.match(ci, /build：https:\/\/github.com\/me\/app\/actions\/runs\/1/)
  assert.match(ci, /不要 force push/)
  assert.match(fixInstruction({ pull, kind: 'conflict', root: '/r', chinese: false }), /git merge origin\/main/)
  assert.match(fixInstruction({ pull, kind: 'review', root: '/r', attempt: 2, chinese: true }), /^（研发工作台 · 自动修复第 2 次）/)
  const head = 'b'.repeat(40)
  const merge = mergeInstruction({ pull, method: 'squash', head, deleteBranch: true, chinese: true })
  assert.match(merge, new RegExp(`gh pr merge ${URL} --squash --match-head-commit ${head}`))
  assert.match(merge, /git push origin --delete feat/)
  assert.match(merge, /不要加 --admin 或 --auto/)
  assert.doesNotMatch(mergeInstruction({ pull, method: 'merge', head, deleteBranch: false, chinese: false }), /--delete/)
})

test('auto-fix sends once per problem per commit, waits for the session and its branch, stops at the limit or when the pull request ends', () => {
  const watch = { attempts: 0, handled: new Set() }
  const pull = { open: true, head: 'h1', mergeable: 'MERGEABLE', checks: [failed] }
  const idle = { onBranch: true, running: false }
  assert.deepEqual(autofixStep(watch, pull, { onBranch: true, running: true }), { action: 'wait', status: 'waiting' })
  assert.deepEqual(autofixStep(watch, pull, { onBranch: false, running: false }), { action: 'wait', status: 'off-branch' })
  assert.deepEqual(autofixStep(watch, pull, idle), { action: 'send', status: 'sent', kind: 'ci' })
  watch.attempts = 1; watch.handled.add('h1:ci')
  assert.deepEqual(autofixStep(watch, pull, idle), { action: 'wait', status: 'watching' }, 'same commit, same problem: not again')
  assert.equal(autofixStep(watch, { ...pull, head: 'h2' }, idle).action, 'send', 'a new commit still failing counts again')
  assert.deepEqual(autofixStep(watch, { ...pull, head: 'h2', checks: [{ state: 'passed' }] }, idle), { action: 'wait', status: 'watching' })
  watch.attempts = AUTOFIX_LIMIT
  assert.deepEqual(autofixStep(watch, { ...pull, head: 'h3' }, idle), { action: 'stop', status: 'limit' })
  assert.deepEqual(autofixStep(watch, { ...pull, open: false }, idle), { action: 'stop', status: 'ended' })
})

test('session pull requests come from gh pr output only, newest first, deduplicated', () => {
  const call = (seq, id, command) => ({ seq, type: 'tool/call', data: { callId: id, name: 'bash', arguments: JSON.stringify({ command }) } })
  const result = (seq, id, text, isError = false) => ({ seq, type: 'tool/result', data: { message: { source: { callId: id }, isError, content: [{ type: 'text', text }] } } })
  const events = [
    call(1, 'a', 'gh pr create --fill'), result(2, 'a', 'https://github.com/me/app/pull/3\n'),
    call(3, 'b', 'echo https://github.com/me/app/pull/99'), result(4, 'b', 'https://github.com/me/app/pull/99'),
    call(5, 'c', 'cd x && gh pr view 7'), result(6, 'c', 'title\thttps://github.com/other/lib/pull/7'),
    call(7, 'd', 'git push'), result(8, 'd', 'remote: https://github.com/me/app/pull/new/feat'),
    call(9, 'e', 'gh pr checks'), result(10, 'e', 'https://github.com/me/app/pull/5', true),
    call(11, 'f', 'gh pr view 3 --json url'), result(12, 'f', '{"url":"https://github.com/me/app/pull/3"}')
  ]
  assert.deepEqual(sessionPullUrls(events), ['https://github.com/me/app/pull/3', 'https://github.com/other/lib/pull/7'])
})

test('a gh pr command moved to a background job is followed through job_output; unrelated jobs and file reads are not', () => {
  // The shapes DSH writes when bash outlives its wait (seen in a real Session's history).
  const call = (seq, id, name, args) => ({ seq, type: 'tool/call', data: { callId: id, name, arguments: JSON.stringify(args) } })
  const result = (seq, id, text) => ({ seq, type: 'tool/result', data: { message: { source: { callId: id }, content: [{ type: 'text', text }] } } })
  const events = [
    call(1, 'a', 'read', { file_path: 'CURRENT.md' }), result(2, 'a', 'see https://github.com/org/lab/pull/90'),
    call(3, 'b', 'bash', { command: 'PATH=/opt/homebrew/bin:$PATH gh pr create --base main --head fix --title x' }),
    { seq: 4, type: 'job/registered', data: { jobId: 'bash-7f9d83bf', kind: 'bash', label: 'PATH=/opt/homebrew/bin:$PATH gh pr create --base main --head fix --title x' } },
    result(5, 'b', '[still running after 1000ms; moved to background job bash-7f9d83bf]'),
    call(6, 'c', 'bash', { command: 'npm test' }), { seq: 7, type: 'job/registered', data: { jobId: 'bash-other', kind: 'bash', label: 'npm test' } },
    result(8, 'c', '[still running after 1000ms; moved to background job bash-other]'),
    call(9, 'd', 'job_output', { job_id: 'bash-other', wait: true }), result(10, 'd', 'see https://github.com/org/lab/pull/91'),
    call(11, 'e', 'job_output', { job_id: 'bash-7f9d83bf', wait: true, timeout_ms: 1000 }), result(12, 'e', 'https://github.com/org/lab/pull/92\n[status: completed, exit code: 0]'),
    // Known only from the bash result, without a job/registered record.
    call(13, 'f', 'bash', { command: 'gh pr view 93 --json url' }), result(14, 'f', '[still running after 1000ms; moved to background job bash-93]'),
    call(15, 'g', 'job_output', { job_id: 'bash-93' }), result(16, 'g', '{"url":"https://github.com/org/lab/pull/93"}')
  ]
  assert.deepEqual(sessionPullUrls(events), ['https://github.com/org/lab/pull/93', 'https://github.com/org/lab/pull/92'])
})

test('a line comment quotes the file, side, lines and comparison in a fence longer than any backticks', () => {
  const lines = [{ kind: ' ', text: 'keep', old: 4, new: 4 }, { kind: '+', text: 'use ```x```', new: 5 }]
  const zh = formatLineComment({ path: 'src/a.js', scope: 'branch', base: 'origin/main', lines, comment: ' 这里为什么改？ ', chinese: true })
  assert.equal(zh, ['代码评论：src/a.js，新版第 4-5 行（分支对比，基线 origin/main）', '````diff', ' keep', '+use ```x```', '````', '评论：这里为什么改？'].join('\n'))
  const removed = formatLineComment({ path: 'b.js', scope: 'uncommitted', lines: [{ kind: '-', text: 'gone', old: 9 }], comment: '', chinese: false })
  assert.equal(removed, ['Code comment: b.js, old lines 9 (uncommitted changes)', '```diff', '-gone', '```'].join('\n'))
})

/** DSH's subprocess service in miniature, unconfined. */
const services = { sandbox: { confine: () => { throw new Error('not confined') } }, subprocess: {
  resolveExecutable: async name => name,
  spawn({ argv, cwd, env }) {
    const merged = { ...process.env }
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete merged[key]; else merged[key] = value }
    const child = spawn(argv[0], argv.slice(1), { cwd, env: merged })
    const out = [], err = []
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk))
    const done = new Promise(resolve => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })))
    const read = parts => ({ readFrom: () => ({ text: Buffer.concat(parts).toString('utf8'), lossy: false }) })
    return { done, collected: { stdout: read(out), stderr: read(err) }, terminate: () => child.kill(), waitForExit: () => done }
  } } }

test('sync: ahead and behind the upstream as recorded locally, not pushed without one', async t => {
  const root = await tempDir(t, 'fig-workbench-sync-')
  const work = join(root, 'work'), remote = join(root, 'remote.git')
  const git = (cwd, ...args) => fixtureGit(cwd)(...args)
  execFileSync('git', ['init', '-q', '--bare', remote])
  await initRepo(work)
  await writeFile(join(work, 'a.txt'), 'a\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'base')
  git(work, 'remote', 'add', 'origin', remote); git(work, 'push', '-q', '-u', 'origin', 'main')
  git(work, 'checkout', '-q', '-b', 'feat')
  const run = gitRunner(services, { mode: 'danger-full-access' }, work, AbortSignal.timeout(20_000))
  assert.deepEqual((await readRepository(run, work)).repository.sync, { upstream: null })
  git(work, 'push', '-q', '-u', 'origin', 'feat')
  await writeFile(join(work, 'b.txt'), 'b\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'one')
  await writeFile(join(work, 'c.txt'), 'c\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'two')
  const { repository } = await readRepository(run, work)
  assert.deepEqual(repository.sync, { upstream: 'origin/feat', ahead: 2, behind: 0 })
  assert.equal(repository.head, git(work, 'rev-parse', 'HEAD').trim())
  const state = await branchState(run)
  assert.deepEqual([state.branch, state.upstream, state.ahead, state.behind, state.head], ['feat', 'origin/feat', 2, 0, repository.head])
  git(work, 'checkout', '-q', '--detach')
  assert.deepEqual(await branchState(run), { refused: 'detached' })
})

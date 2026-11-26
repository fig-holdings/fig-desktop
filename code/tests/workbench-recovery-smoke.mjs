import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isolatedDevEnvironment } from '../scripts/dev-isolation.mjs'
import { isolatedProfile, launchFig, until, workbenchPage } from '../scripts/isolated-fig.mjs'
import { exited, profileLifecycle } from '../scripts/verification-lifecycle.mjs'

const evidence = fileURLToPath(new URL('../../work/verification/t3-b1-b2/', import.meta.url))
const report = { status: 'fail', checks: [] }
const wait = (fn, message) => until(fn, { timeout: 10_000, interval: 35, message })

async function scenario(mode, verify) {
  const lifecycle = await profileLifecycle({ evidence, prefix: mode + '-' })
  const { env } = await isolatedProfile(mode, {
    base: isolatedDevEnvironment(), profile: lifecycle.profile,
    extraEnv: directory => ({ CODEX_HOME: join(directory, 'codex'), FIG_FIXTURE_MODE: mode })
  })
  let app, passed = false
  try {
    app = lifecycle.track(await launchFig(env, { args: ['--fig-smoke'] }))
    const startup = await app.firstWindow()
    const state = () => startup.evaluate(() => window.fig.getState())
    const fixture = () => readFile(join(lifecycle.profile, 'fixture.json'), 'utf8').then(JSON.parse)
    const view = () => app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const contents = window.contentView.children[0]?.webContents
      const pid = contents?.getOSProcessId()
      if (!contents || contents.isCrashed() || !pid || pid <= 1) return null
      return {
        id: contents.id, pid,
        origin: new URL(contents.getURL()).origin
      }
    })
    const kill = async expected => {
      const owned = await fixture()
      return app.evaluate(({ BrowserWindow, app }, { expected, owned, main, profile }) => {
        const window = BrowserWindow.getAllWindows()[0]
        const contents = window.contentView.children[0]?.webContents
        const pid = contents?.getOSProcessId()
        const url = contents && new URL(contents.getURL())
        if (process.pid !== main || app.getPath('userData') !== profile ||
            contents?.id !== expected.id || pid !== expected.pid || !pid || pid <= 1 ||
            pid === main || pid === window.webContents.getOSProcessId() ||
            pid === owned.pid || pid === owned.workerPid ||
            url?.origin !== `http://127.0.0.1:${owned.port}`) throw new Error('Target is not the owned workbench renderer')
        process.kill(pid, 'SIGKILL')
        return pid
      }, { expected, owned, main: app.process().pid, profile: lifecycle.profile })
    }
    const page = await workbenchPage(app)
    await page.locator('[data-authorizations="1"]').waitFor()
    await wait(view, 'workbench never attached')
    await verify({ app, startup, page, view, state, fixture, kill })
    await lifecycle.close(app)
    passed = true
  } finally {
    await lifecycle.close(app).catch(error => { passed = false; throw error }).finally(() => lifecycle.finish(passed))
  }
}

try {
  await scenario('recovery', async ({ app, startup, page, view, state, fixture, kill }) => {
    await page.getByRole('button', { name: 'Open synthetic session' }).click()
    assert.equal(await page.getByRole('main').textContent(), 'original')
    const before = await view()
    const originalService = await fixture()
    for (let i = 0; i < 3; i++) {
      const killed = await kill(await view())
      const after = await wait(async () => {
        const current = await view()
        return current && current.pid !== killed && current
      }, 'automatic reload did not reattach a new renderer')
      assert.equal(after.id, before.id)
      assert.equal(after.origin, before.origin)
      assert.equal((await state()).pid, originalService.pid)
      // Playwright marks the Page permanently crashed even though Electron has replaced its renderer.
      const restored = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.executeJavaScript(
          '({ session: document.querySelector("main").textContent, authorizations: document.body.dataset.authorizations })'))
      assert.deepEqual(restored, { session: 'original', authorizations: String(i + 2) })
      const value = await app.evaluate(async ({ session }) =>
        (await session.fromPartition('persist:fig-dsh').cookies.get({ name: 'dsh-auth-fixture' }))[0]?.value)
      assert.equal(value, String(i + 2), 'the same DSH process must reissue the Cookie')
    }
    report.checks.push('SIGKILL targeted only the isolated workbench renderer; renderer, authenticated Cookie and original selection recovered within the same DSH launch')
    await kill(await view())
    await wait(async () => (await state()).workbenchRecovery === 'rate-limited', 'fourth crash did not enter rate limiting')
    await delay(750)
    assert.equal(await view(), null)
    assert.equal((await state()).pid, originalService.pid)
    await startup.getByRole('button', { name: /^(重启 DSH|Restart DSH)$/ }).click()
    const newService = await wait(async () => {
      const next = await fixture()
      return next.pid !== originalService.pid && next
    }, 'manual retry did not start a new DSH launch')
    const afterRetry = await wait(view, 'manual retry did not attach')
    assert.notEqual(afterRetry.id, before.id)
    assert.equal((await state()).pid, newService.pid)
    assert.equal((await state()).workbenchRecovery, undefined)
    assert.ok(await exited([originalService.pid, originalService.workerPid, -originalService.pid]))
    report.checks.push('fourth crash entered rate limiting; manual retry cancelled recovery and ran the normal DSH restart path')

    await kill(afterRetry)
    await wait(async () => (await state()).workbenchRecovery === 'recovering', 'new generation did not reset crash history')
    await fetch(afterRetry.origin + '/crash').then(response => response.text())
    await wait(async () => (await state()).phase === 'failed', 'DSH exit did not surface its own failure')
    await delay(650)
    assert.equal(await view(), null)
    assert.equal((await state()).workbenchRecovery, undefined)
    assert.match((await state()).message, /DSH 意外停止|DSH stopped unexpectedly/)
    assert.ok(await exited([newService.pid, newService.workerPid, -newService.pid]))
    report.checks.push('DSH exited while the renderer waited; the service failure won and the old view never reattached')
  })
  await scenario('recovery-fails', async ({ view, state, kill }) => {
    await kill(await view())
    await wait(async () => (await state()).phase === 'failed', 'HTTP failure did not reach the existing error page')
    const final = await state()
    assert.match(final.error, /工作台自动恢复失败|could not recover automatically/)
    assert.doesNotMatch(JSON.stringify(final), /fixture-token/)
    assert.equal(await view(), null)
    report.checks.push('HTTP 503 in the recovery navigation fell back to the existing error page without disclosing the launch token')
  })
  report.status = 'pass'
} finally {
  await writeFile(join(evidence, 'renderer-recovery.json'), JSON.stringify(report, null, 2) + '\n')
}

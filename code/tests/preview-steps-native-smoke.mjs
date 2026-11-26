import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir, readFile, writeFile, symlink, cp, readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {execFileSync} from 'node:child_process'
import {isolatedProfile, launchFig, workbenchPage, cleanUp, until} from '../scripts/isolated-fig.mjs'
const evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11); assert.ok(evidence); await mkdir(evidence)
const expected = ['read-only','rejected','cancelled','unavailable','native-ui-allow','native-ui-reject','approved-counter-fill','full-access','changed-permission','custom','auto','double-width','file-root','file-steps','cross-origin','redirect','download','new-window','file-chooser','iframe','external-resource','password','step-timeout','cancel-cleanup','never']
const report = {status: 'fail', suite: 'subset', expectedScenarioIds: expected, results: [], startedAt: new Date().toISOString(), scope: 'No models/credentials; actual native effective presets and ApprovalService (test-only answerer), owned Electron capture, synthetic HTTP counters/DOM'}
const counters = new Map(), visits = new Map(); let otherRequests = 0
const other = createServer((_req, res) => {otherRequests++; res.end('forbidden')})
await new Promise(resolve => other.listen(0, '127.0.0.1', resolve))
const forbidden = `http://127.0.0.1:${other.address().port}`
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'), id = url.searchParams.get('case') ?? 'none'
  visits.set(id, (visits.get(id) ?? 0) + 1)
  if (url.pathname === '/count') {counters.set(id, (counters.get(id) ?? 0) + 1); res.end(String(counters.get(id))); return}
  if (url.pathname === '/redirect') {res.writeHead(302, {location: forbidden + '/forbidden'}); res.end(); return}
  if (url.pathname === '/download') {res.writeHead(200, {'content-disposition': 'attachment; filename=blocked.txt'}); res.end('not saved'); return}
  const mode = url.searchParams.get('mode')
  res.setHeader('content-type', 'text/html')
  res.end(`<!doctype html><title>Synthetic preview steps</title><meta name="viewport" content="width=device-width"><style>body{font:16px system-ui;padding:24px}button,input{margin:8px;padding:8px}</style>
    <button id="add">Add</button><output id="counter" data-count="0">0</output><input id="field"><output id="echo"></output>
    <input id="password" type="password"><input id="file" type="file" hidden><button id="proxy-file">Select file</button>
    <button id="cross">Cross origin</button><a id="redirect" href="/redirect?case=${id}">Redirect</a><a id="download" download href="/download?case=${id}">Download</a><a id="new" target="_blank" href="${forbidden}/forbidden">New window</a>
    ${mode === 'iframe' ? '<iframe src="' + forbidden + '/forbidden"></iframe>' : ''}${mode === 'external' ? '<img src="' + forbidden + '/forbidden">' : ''}
    <script>document.querySelector('#add').onclick=async()=>{let n=await(await fetch('/count?case=${id}',{method:'POST'})).text();let c=document.querySelector('#counter');c.textContent=n;c.dataset.count=n};document.querySelector('#field').oninput=e=>document.querySelector('#echo').textContent=e.target.value;document.querySelector('#cross').onclick=()=>location.href='${forbidden}/forbidden';document.querySelector('#proxy-file').onclick=()=>document.querySelector('#file').click()</script>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let app, page, state, id
const wait = (check, ms = 15000) => until(check, {timeout: ms, interval: 50, message: 'preview native fixture timeout'})
const rpc = (prefix, endpoint, payload = {}) => page.evaluate(async ({prefix, endpoint, payload}) => (await fetch(prefix + '/' + endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)})).json(), {prefix, endpoint, payload}).then(r => {assert.ok(r.ok, JSON.stringify(r.error)); return r.value})
const probe = (e, p) => rpc('/handoff-probe', e, p), preview = (e, p) => rpc('/preview-probe', e, p)
const click = selector => ({action: 'click', selector}), waitFor = selector => ({action: 'waitFor', selector})
const argsFor = (name, steps = [click('#add')], mode = '') => ({target: origin + '/page?case=' + name + (mode ? '&mode=' + mode : ''), widths: [390], steps, selectors: ['#counter','#echo']})
const valueOf = record => record.result?.value
const rejected = record => Boolean(record.result?.isError || record.result?.error)
const configure = async (preset, mode = 'allowed-once', extra = {}) => preview('configure', {id, preset, mode, ...extra})
const run = async args => {
  const {key} = await preview('run', {id, args})
  const record = await wait(async () => {const r = await preview('status', {key}); return r.status === 'done' && r}, 20000)
  return {key, ...record}
}
const check = async (name, fn) => {
  const start = Date.now()
  try {const detail = await fn(); report.results.push({id: name, status: 'pass', elapsedMs: Date.now() - start, ...(detail ? {detail} : {})}); console.log('PASS', name)}
  catch (error) {report.results.push({id: name, status: 'fail', error: String(error.message)}); throw error}
}
async function launch(never = false) {
  state = await isolatedProfile('preview-steps-native', {extraEnv: p => ({GROK_HOME: join(p, 'grok'), GROK_AUTH_PATH: join(p, 'grok/auth.json')})})
  await writeFile(join(state.dshHome, 'profiles/web/cordis.patch.yml'), JSON.stringify([
    {id: 'workspace-controller', config: {documentsDirectory: state.documents}},
    ...(never ? [{id: 'permission', config: {defaultPreset: 'workspace-write', presets: {'read-only': {sandbox: 'read-only', approval: 'ask'}, 'workspace-write': {sandbox: 'workspace-write', approval: 'never'}, 'danger-full-access': {sandbox: 'danger-full-access', approval: 'never'}}}}] : []),
    {insert: [{id: 'handoff-probe', name: fileURLToPath(new URL('./fixtures/handoff-probe.mjs', import.meta.url))}, {id: 'preview-probe', name: fileURLToPath(new URL('./fixtures/preview-probe.mjs', import.meta.url))}]}
  ]))
  app = await launchFig(state.env); page = await workbenchPage(app)
  await page.getByRole('button', {name: /^(继续|Continue)$/}).click()
  ;({id} = await probe('parent', {workspacePath: state.workspace, cwd: state.workspace, preset: 'workspace-write', title: 'Synthetic preview permissions'}))
  await probe('followup', {id, text: 'Initialize offline fixture.'})
  const row = page.getByText('Synthetic preview permissions', {exact: true}).first()
  if (!await row.isVisible().catch(() => false)) await page.getByText('默认工作区', {exact: true}).first().click()
  const ack = await page.evaluate(({id}) => window.__figAttentionNavigate({sessionId: id, eventIdentity: 'synthetic', navigationId: 'preview-fixture'}), {id})
  assert.equal(ack.accepted, true)
  await page.locator('[data-conversation-session="' + id + '"]').first().waitFor()
  await probe('cancel', {id}); await wait(async () => !(await probe('state', {id})).running)
  await probe('hold', {id}); await probe('followup', {id, text: 'Hold native open turn without model.'}); await wait(async () => (await probe('held', {id})).entries.length > 0)
}
try {
  await launch()
  report.meta = await preview('meta'); assert.equal(report.meta.available, true, 'Native preview must be registered before negative cases')
  for (const [name, preset, answer] of [['read-only','read-only','allowed-once'], ['rejected','workspace-write','rejected'], ['cancelled','workspace-write','cancelled'], ['unavailable','workspace-write','unavailable']]) await check(name, async () => {
    const config = await configure(preset, answer); const result = await run(argsFor(name)); assert.ok(rejected(result), JSON.stringify(result)); assert.ok(!/UNKNOWN_TOOL|unknown tool/.test(JSON.stringify(result))); assert.equal(visits.get(name) ?? 0, 0); return {effective: config.current, beforeLoadDenied: true}
  })
  for (const [name, button, allowed] of [['native-ui-allow','允许一次',true],['native-ui-reject','拒绝',false]]) await check(name, async () => {
    await configure('workspace-write','native-ui')
    const {key} = await preview('run',{id,args:argsFor(name,[click('#add'),waitFor('#counter[data-count="1"]')])})
    const control = page.getByRole('button',{name:button,exact:true}).first()
    await control.waitFor({timeout:15000}); assert.equal(visits.get(name)??0,0)
    await page.screenshot({path:join(evidence,name+'-approval.png')}); await control.click()
    const result=await wait(async()=>{const r=await preview('status',{key});return r.status==='done'&&r},20000)
    if(allowed){assert.equal(valueOf(result)?.status,'pass',JSON.stringify(result));assert.equal(counters.get(name),1)}
    else{assert.ok(rejected(result));assert.equal(visits.get(name)??0,0)}
    return {nativeCardClicked:true,sideEffectCount:counters.get(name)??0}
  })
  await check('approved-counter-fill', async () => {
    await configure('workspace-write')
    const result = await run(argsFor('approved-counter-fill', [click('#add'), waitFor('#counter[data-count="1"]'), {action: 'fill', selector: '#field', text: 'SYNTHETIC'}, waitFor('#echo')]))
    const value = valueOf(result); assert.equal(value?.status, 'pass', JSON.stringify(result)); assert.equal(counters.get('approved-counter-fill'), 1)
    assert.equal(value.steps[1].observation, '1'); assert.equal(value.steps[3].observation, 'SYNTHETIC')
    await cp(value.views[0].screenshot, join(evidence, 'counter-fill.png')); await writeFile(join(evidence, 'counter-fill.json'), JSON.stringify(value, null, 2)); return {count: 1, steps: value.steps}
  })
  await check('full-access', async () => {
    const config = await configure('danger-full-access'), before = config.asked
    const result = await run(argsFor('full-access', [click('#add'), waitFor('#counter[data-count="1"]')]))
    assert.equal(valueOf(result)?.status, 'pass', JSON.stringify(result)); assert.equal((await preview('stats')).asked, before); assert.equal(counters.get('full-access'), 1); return {effective: config.current, asked: 0}
  })
  await check('changed-permission', async () => {
    await configure('workspace-write', 'defer')
    const {key} = await preview('run', {id, args: argsFor('changed-permission')})
    await wait(async () => (await preview('stats')).waiting === 1)
    await configure('read-only'); await preview('answer', {id})
    const result = await wait(async () => {const r = await preview('status', {key}); return r.status === 'done' && r})
    assert.ok(rejected(result)); assert.equal(visits.get('changed-permission') ?? 0, 0)
  })
  for (const name of ['custom','auto']) await check(name, async () => {
    const config = await configure(name); assert.equal(config.current, name)
    assert.ok(rejected(await run(argsFor(name)))); assert.equal(visits.get(name) ?? 0, 0); return {effective: config.current}
  })
  await configure('danger-full-access')
  await check('double-width', async () => {const args = {...argsFor('double-width'), widths: [390,1440]}; assert.ok(rejected(await run(args))); assert.equal(visits.get('double-width') ?? 0, 0)})
  await mkdir(state.workspace, {recursive: true})
  const outside = join(state.profile, 'outside.html'); await writeFile(outside, '<p>NOT-ALLOWED</p>'); await symlink(outside, join(state.workspace, 'escape.html'))
  await check('file-root', async () => {assert.ok(rejected(await run({target: join(state.workspace, 'escape.html'), steps: [waitFor('p')]})))})
  const localFile = join(state.workspace, 'steps.html'); await writeFile(localFile, '<!doctype html><button id="add" onclick="document.querySelector(\'#n\').textContent=\'1\'">Add</button><p id="n">0</p>')
  await check('file-steps', async () => {const result = await run({target: localFile, steps: [click('#add'), waitFor('#n')], widths: [390]}); const value = valueOf(result); assert.equal(value?.status, 'pass', JSON.stringify(result)); assert.equal(value.steps[1].observation, '1'); return {observed: '1'}})
  for (const [name, selector, mode] of [['cross-origin','#cross',''], ['redirect','#redirect',''], ['download','#download',''], ['new-window','#new',''], ['file-chooser','#proxy-file',''], ['iframe','#add','iframe'], ['external-resource','#add','external'], ['password','#password','']]) await check(name, async () => {
    const before = otherRequests
    const steps = [name === 'password' ? {action: 'fill', selector, text: 'SYNTHETIC'} : click(selector), click('#add')]
    const result = await run(argsFor(name, steps, mode)), value = valueOf(result)
    assert.ok(value?.status === 'stopped' || rejected(result), JSON.stringify(result))
    if (value) assert.ok(value.steps?.some(step => step.status !== 'pass'))
    assert.equal(counters.get(name) ?? 0, 0); assert.equal(otherRequests, before)
    if (name === 'download') assert.equal(visits.get(name), 1, 'only page loaded, no download request')
    return {stopped: true, forbiddenRequests: 0, value}
  })
  await check('step-timeout', async () => {
    const started = Date.now(), result = await run(argsFor('step-timeout', [waitFor('#never'), click('#add')]))
    assert.equal(valueOf(result)?.status, 'stopped', JSON.stringify(result)); assert.equal(valueOf(result).steps[0].status, 'fail'); assert.equal(valueOf(result).steps[1].status, 'skipped'); assert.equal(counters.get('step-timeout') ?? 0, 0)
    assert.ok(Date.now() - started >= 4900 && Date.now() - started < 13000)
  })
  await check('cancel-cleanup', async () => {
    const {key} = await preview('run', {id, args: argsFor('cancel-cleanup', [click('#add'), waitFor('#never'), click('#add')])})
    await wait(() => counters.get('cancel-cleanup') === 1)
    let pids = []; try {pids = execFileSync('pgrep', ['-f', state.dshHome + '/fig/preview/']).toString().trim().split('\n').map(Number)} catch {}
    assert.ok(pids.length)
    await preview('stop', {key}); const result = await wait(async () => {const r = await preview('status', {key}); return r.status === 'done' && r})
    assert.ok(rejected(result)); await delay(250); assert.equal(counters.get('cancel-cleanup'), 1)
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'})
    return {count: 1, capturedOwnedPidsExited: true}
  })
  await probe('cancel', {id}); await app.close(); app = undefined; await cleanUp(state.profile); state = undefined
  await launch(true)
  await check('never', async () => {
    const config = await configure('workspace-write'); assert.equal(config.current, 'workspace-write'); assert.equal(config.spec.approval, 'never')
    const before = config.asked; assert.ok(rejected(await run(argsFor('never')))); assert.equal(visits.get('never') ?? 0, 0); assert.equal((await preview('stats')).asked, before)
    return {effective: config.current, policy: config.spec.approval, beforeLoadDenied: true}
  })
  assert.equal(report.results.length, expected.length); assert.ok(report.results.every(r => r.status === 'pass')); report.status = 'pass'
} catch (error) {if (app) report.serviceState = await (await app.firstWindow()).evaluate(() => window.fig.getState()).catch(() => undefined); report.error = String(error.stack ?? error); for (const name of expected) if (!report.results.some(r => r.id === name)) report.results.push({id: name, status: 'skipped', reason: 'Earlier assertion failed'}); process.exitCode = 1}
finally {report.counters = Object.fromEntries(counters); report.visits = Object.fromEntries(visits); report.forbiddenRequests = otherRequests; report.finishedAt = new Date().toISOString(); await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2)); if (app) await app.close().catch(() => {}); if (state) await cp(join(state.dshHome, 'fig/preview'), join(evidence, 'captures'), {recursive: true}).catch(() => {}); if (state) await cleanUp(state.profile, report.status === 'pass'); server.closeAllConnections(); other.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => other.close(r))])}

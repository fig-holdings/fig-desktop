import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

// Deliberately small substitute for lifecycle tests; never used by a normal launch.
const mode = process.env.FIG_FIXTURE_MODE
if (mode === 'fail') { console.error('Fixture: startup failed intentionally.'); process.exit(23) }
const testingRecovery = mode?.startsWith('recovery')
const authCookie = testingRecovery ? 'dsh-auth-fixture' : 'fig-fixture'
let authorizations = 0
const worker = spawn(process.execPath, ['-e', mode === 'stubborn'
  ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  : 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
const server = http.createServer((request, response) => {
  if (mode === 'bad-page') { request.socket.destroy(); return }
  if (request.url === '/crash') { response.end('bye'); setTimeout(() => process.exit(17), 10); return }
  const url = new URL(request.url, 'http://127.0.0.1')
  const authValue = () => testingRecovery ? String(authorizations) : 'yes'
  if (url.searchParams.get('token') === 'fixture-token') {
    authorizations++
    if (mode === 'recovery-fails' && authorizations > 1) {
      response.writeHead(503)
      response.end('Fixture: automatic recovery is unavailable')
      return
    }
    response.writeHead(303, { 'Cache-Control': 'no-store', 'Set-Cookie': `${authCookie}=${authValue()}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' })
    response.end()
    return
  }
  if (!request.headers.cookie?.split('; ').includes(`${authCookie}=${authValue()}`)) { response.writeHead(401); response.end('Sign-in required'); return }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  if (testingRecovery) {
    response.end(`<!doctype html><html><meta charset="utf-8"><title>DSH recovery fixture</title>
<body data-authorizations="${authorizations}">
<button data-session="original">Open synthetic session</button>
<main aria-label="Conversation"></main>
<script>
const selected = document.querySelector('main')
function showSession() { selected.textContent = localStorage.getItem('selected-session') || 'new' }
document.querySelector('button').onclick = () => { localStorage.setItem('selected-session', 'original'); showSession() }
showSession()
</script></body></html>`)
    return
  }
  response.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>DSH fixture</title><body style="font:16px system-ui;padding:48px"><h1 data-testid="fixture-ready">DSH fixture ready</h1><p>Only for Fig Desktop lifecycle verification.</p></body></html>')
})
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  if (process.env.FIG_FIXTURE_RECORD) writeFileSync(process.env.FIG_FIXTURE_RECORD, JSON.stringify({ pid: process.pid, workerPid: worker.pid, port }))
  if (mode !== 'hang') setTimeout(() => console.log(`dsh web: http://127.0.0.1:${port}/?token=fixture-token`), mode === 'slow' ? 1200 : 80)
})
process.on('SIGTERM', () => { server.close(); process.exit(0) })

import assert from 'node:assert/strict'
import {mkdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {apply} from '../harness/preview/index.js'
const modules = process.argv.find(a => a.startsWith('--modules='))?.slice(10), evidence = process.argv.find(a => a.startsWith('--evidence='))?.slice(11)
assert.ok(modules && evidence); await mkdir(evidence)
const report = {status: 'fail', startedAt: new Date().toISOString(), scope: 'Actual fixed DSH defineTool schema compiler, no GUI/model/credential access'}
try {
  process.argv[1] = join(modules, '@deepseek-ai/dsh/lib/bin.js')
  let tool
  // The screenshot route (shared/http.js registerPageRoute) needs a web server; the stub's accepts and ignores it.
  const scope = {shellCapabilities: {renderPage: async () => {}}, webServer: {register: () => () => {}}, connection: {}, effect: fn => fn()}
  apply({inject: (_names, fn) => fn(scope), tools: {register: value => {tool = value; return () => {}}}, get: () => undefined, logger: {warn: message => { report.warning = String(message) }}})
  for (let i = 0; i < 100 && !tool; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(tool.name, 'preview')
  assert.equal(await tool.isConcurrencySafe({target: 'x.html'}), true)
  assert.equal(await tool.isConcurrencySafe({target: 'x.html', steps: [{action: 'click', selector: '#x'}]}), false)
  assert.equal(tool.presentCall({target: 'x', steps: [{action: 'click', selector: '#x'}]}).kind, 'write')
  report.status = 'pass'
} catch (error) {report.error = String(error.stack ?? error); process.exitCode = 1}
finally {report.finishedAt = new Date().toISOString(); await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2))}

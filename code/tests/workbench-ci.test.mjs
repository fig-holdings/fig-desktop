import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeCheck,ciSummary,pollDelay,safeCheckUrl} from '../harness/development-workbench/ci.js'
import {shapePulls,pullState} from '../harness/development-workbench/pulls.js'
test('CI preserves individual terminal and active states without treating skip or cancellation as success',()=>{
 const states=['SUCCESS','FAILURE','TIMED_OUT','CANCELLED','SKIPPED','NEUTRAL','ACTION_REQUIRED','STALE']
 const checks=states.map(conclusion=>normalizeCheck({name:conclusion,status:'COMPLETED',conclusion}))
 assert.deepEqual(checks.map(c=>c.state),['passed','failed','timed-out','cancelled','skipped','neutral','action-required','stale'])
 checks.push(normalizeCheck({status:'IN_PROGRESS'}),normalizeCheck({status:'QUEUED'}),normalizeCheck({status:'OTHER'}))
 assert.deepEqual(ciSummary(checks),{total:11,completed:8,running:1,queued:1,failed:4,unknown:1})
 assert.equal(pullState({statusCheckRollup:[{status:'COMPLETED',conclusion:'CANCELLED'}]}),'none')
 assert.equal(normalizeCheck({__typename:'StatusContext',state:'SUCCESS',context:'legacy'}).state,'passed')
})
test('CI shaping retains names, log links and timing and marks rollup completeness honestly',()=>{
 const [p]=shapePulls(JSON.stringify([{number:1,statusCheckRollup:[{name:'build',status:'IN_PROGRESS',detailsUrl:'https://example.com/log',startedAt:'2026-11-17T10:00:00Z'}]}]),null)
 assert.equal(p.checks[0].name,'build');assert.equal(p.ci.running,1);assert.equal(p.checksComplete,false)
 assert.equal(safeCheckUrl('javascript:alert(1)'),undefined)
 assert.equal(pollDelay({pulls:[p]}),15000)
 assert.equal(pollDelay({pulls:[]}),120000)
 assert.equal(pollDelay({pulls:[p]},'offline'),60000)
})

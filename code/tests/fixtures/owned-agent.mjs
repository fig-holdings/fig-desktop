import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [mode, record] = process.argv.slice(2)
const worker = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); console.log("worker-ready"); setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'inherit'] })
worker.stdout.once('data', () => {
  writeFileSync(record, JSON.stringify({ cli: process.pid, supervisor: process.ppid, worker: worker.pid }))
  if (mode === 'normal') { console.log('fixture-answer'); process.exit(7) }
  if (mode === 'leader-crash') process.kill(process.ppid, 'SIGKILL')
})
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)

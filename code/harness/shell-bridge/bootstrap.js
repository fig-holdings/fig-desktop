// --import completes before DSH and its environment snapshots. FD3 is a private one-use pipe;
// neither argv nor the original exec environment carries the capability. NODE_OPTIONS is preserved.
import { createReadStream } from 'node:fs'
const pipe = createReadStream('', {fd: 3, autoClose: true})
const timer = setTimeout(() => pipe.destroy(new Error('Attention bootstrap timeout')), 5000)
let input = ''
try {for await (const chunk of pipe) {input += chunk.toString(); if (Buffer.byteLength(input) > 1024) throw new Error('Attention bootstrap bound')}}
finally {clearTimeout(timer); pipe.destroy()}
let payload
try {payload = JSON.parse(input)} catch {throw new Error('Invalid attention bootstrap')}
const {capability, generation, teamPort, teamCapability} = payload ?? {}
if (!/^[a-f0-9]{64}$/.test(capability ?? '') || !/^[a-f0-9-]{36}$/.test(generation ?? '') ||
  (teamPort !== undefined && (!Number.isInteger(teamPort) || teamPort < 1 || teamPort > 65535 || !/^[a-f0-9]{64}$/.test(teamCapability ?? ''))))
  throw new Error('Invalid attention bootstrap')
Object.defineProperty(globalThis, Symbol.for('fig.attention.bootstrap'), {value: Object.freeze({capability, generation, teamPort, teamCapability}), configurable: true})

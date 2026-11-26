import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { acceptProfileMigration } from '../scripts/profile-migration-acceptance.mjs'

const evidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
const appPath = process.argv.find(arg => arg.startsWith('--app-path='))?.slice(11)
assert.ok(evidence && isAbsolute(evidence), 'Provide a new absolute --evidence directory')
assert.ok(appPath === undefined || isAbsolute(appPath), 'Use an absolute path to the JS payload')
await acceptProfileMigration({evidence,appPath})
console.log('PASS: legacy Profile migration')

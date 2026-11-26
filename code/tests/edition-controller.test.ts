import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EditionController, type EditionHost } from '../app/main/edition-controller'
import type { CoworkSession } from '../app/main/cowork-session'

async function setup(t: test.TestContext, profileEdition?: 'team' | 'personal') {
  const userData = await mkdtemp(join(tmpdir(), 'fig-edition-'))
  t.after(() => rm(userData, { recursive: true, force: true }))
  await mkdir(join(userData, 'cowork'), { recursive: true })
  await writeFile(join(userData, 'cowork', 'edition.json'), JSON.stringify({ edition: 'team' }))
  const launched: string[] = []
  let lookups = 0
  let answer: (value: { identity: any, profile?: string }) => void = () => {}
  const session = {
    current: () => { lookups++; return new Promise(resolve => { answer = resolve }) }
  } as unknown as CoworkSession
  const host: EditionHost = {
    userData, personalHome: () => '/personal', profileEdition: () => profileEdition, quitting: () => false, blocked: () => false,
    attached: () => true, confirmChange: async () => true, ask: async () => 0, errorBox: () => {}, openExternal: async () => {},
    trash: async () => {}, stop: async () => {}, launch: async home => { launched.push(home) }, changed: () => {}, pageChanged: () => {}
  }
  const edition = new EditionController(host, session, { issuer: 'https://cowork.example', origin: 'https://cowork.example', clientId: 'fig' })
  const identity = { member: 'm', name: 'Member', models: { organizationProviders: [], allowPersonal: true } }
  return { userData, edition, launched, identity, lookups: () => lookups, answer: (profile?: string) => answer({ identity, profile }) }
}

test('A Team Profile without a Cowork session can start sign-in from the account menu', async t => {
  const f = await setup(t, 'team')
  assert.equal(f.edition.state().edition, 'team')
  assert.equal(f.edition.state().name, undefined)
  const login = f.edition.action('team')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.lookups(), 1)
  f.answer('device-profile')
  await login
  assert.equal(f.edition.state().name, 'Member')
  await f.edition.action('team')
  assert.equal(f.lookups(), 1, 'an active Team Profile does not start a duplicate login')
})

test('Return to Personal during the startup Cowork lookup wins: the late answer starts nothing', async t => {
  const f = await setup(t)
  const starting = f.edition.start()
  assert.ok(f.edition.busy, 'the startup lookup is the edition task')
  while (f.lookups() === 0) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.edition.screen, 'signing-in')
  const personal = f.edition.action('personal')
  f.answer('device-profile')
  await Promise.all([starting, personal])
  assert.deepEqual(f.launched, ['/personal'], 'only the personal DSH runs')
  assert.equal(f.edition.selected, false)
  assert.deepEqual(JSON.parse(await readFile(join(f.userData, 'cowork', 'edition.json'), 'utf8')), { edition: 'personal' })
})

test('Check Again during the startup lookup waits for it instead of a second lookup with the same grant', async t => {
  const f = await setup(t)
  const starting = f.edition.start()
  while (f.lookups() === 0) await new Promise(resolve => setImmediate(resolve))
  const check = f.edition.action('check')
  f.answer('device-profile')
  await Promise.all([starting, check])
  assert.equal(f.lookups(), 1)
  assert.deepEqual(f.launched, [join(f.userData, 'cowork', 'profiles', 'device-profile')])
})

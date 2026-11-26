// Plugin updates from the command line. Run through npm:
//   npm run plugin:pack -- <package> [--key=<file>] [--no-build]   build, npm pack and sign one feature package
//   npm run plugin:install -- <archive.tgz> [--home=<DSH_HOME>] [--daily]   check it and place it for the next start
//   npm run plugin:list -- [--home=<DSH_HOME>]                    what is placed and what the last start used
//   npm run plugin:revert -- <package> [--home=<DSH_HOME>] [--daily]   remove its updates: the built-in copy returns
//   npm run plugin:ship [-- --dry-run]   「打包」 for plugin-only changes: build, compare with the installed .app, and when only
//     feature packages differ, raise their versions, pack, sign and place them in the daily Fig's data folder
//     (authorized by the user, AGENTS.md). Anything else differing means a full package (npm run package:mac).
// <package> is a folder name from harness/plugins.ts (side-chat, composer, ...). The home defaults to the isolated
// development data (work/dev-profile/dsh); a data folder outside work/ is changed only with --daily. Fig itself
// verifies again at start (app/main/plugin-updates.ts) with the keys built into it.
import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { figPlugins } from '../harness/plugins.ts'
import { verifyArchive } from '../app/main/external-plugins.ts'
import { readUpdateRecord, updateArchives, updatesRoot } from '../app/main/plugin-updates.ts'

const code = fileURLToPath(new URL('..', import.meta.url))
const work = resolve(code, '../work')
const [command, target] = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const flag = name => process.argv.includes(`--${name}`)
const home = resolve(option('home') ?? join(work, 'dev-profile/dsh'))
const appVersion = JSON.parse(await readFile(join(code, 'package.json'), 'utf8')).version
const { keys } = JSON.parse(await readFile(join(code, 'harness/plugin-update-keys.json'), 'utf8'))
const features = figPlugins.filter(plugin => plugin.bundle)

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message)
  process.exit(1)
}

function feature(name) {
  const plugin = features.find(item => item.name === name)
  if (!plugin) fail(`Not a feature package: ${name}. One of: ${features.map(item => item.name).join(', ')}`)
  return plugin
}

/** Changes outside work/ only on request: the daily data folder is the user's. */
function guardHome() {
  if (!(home + sep).startsWith(work + sep) && !flag('daily')) fail(`${home} is outside work/; add --daily to change that data folder`)
}

/** An archive's package.json, read without unpacking. */
function archiveManifest(path) {
  return JSON.parse(execFileSync('tar', ['-xzOf', path, 'package/package.json'], { encoding: 'utf8' }))
}

const build = () => execFileSync('npm', ['run', 'build'], { cwd: code, stdio: ['ignore', 'ignore', 'inherit'] })

async function pack() {
  const plugin = feature(target)
  if (!flag('no-build')) build()
  const archive = await packOne(plugin.name)
  console.log('Fig uses it only when this version is newer than the built-in copy of the Fig it is installed into.')
  return archive
}

/** Packs and signs one built feature package; returns the archive. */
async function packOne(name) {
  const folder = join(work, 'build/main', name)
  const manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
  if (manifest.fig?.base !== appVersion) fail(`The build is for Fig ${manifest.fig?.base}, not ${appVersion}; build again`)
  const keyPath = option('key') ?? join(work, 'plugin-keys/dev.json')
  const key = JSON.parse(await readFile(keyPath, 'utf8').catch(() => fail(`No signing key at ${keyPath}`)))
  if (!keys.some(item => item.id === key.id)) fail(`Key ${key.id} is not in harness/plugin-update-keys.json; Fig would refuse the package`)
  const out = join(work, 'plugin-packages')
  await mkdir(out, { recursive: true })
  // npm 12 keys the result by package name; earlier releases return an array.
  const packed = JSON.parse(execFileSync('npm', ['pack', folder, '--pack-destination', out, '--json'], { cwd: out, encoding: 'utf8' }))
  const [{ filename }] = Array.isArray(packed) ? packed : Object.values(packed)
  const archive = join(out, filename)
  const bytes = await readFile(archive)
  const signature = sign(null, bytes, createPrivateKey({ key: Buffer.from(key.privateKey, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64')
  await writeFile(archive + '.sig.json', JSON.stringify({ keyId: key.id, algorithm: 'ed25519', sha256: createHash('sha256').update(bytes).digest('hex'), signature }, null, 2) + '\n')
  console.log(`${archive}\n${manifest.name} ${manifest.version} for Fig ${appVersion}, signed with ${key.id}.`)
  return archive
}

async function install() {
  guardHome()
  await place(resolve(target ?? fail('Name the archive (.tgz) to install')), home)
}

/** Checks a signed archive and copies it with its signature into `into`'s fig/updates/. */
async function place(archive, into) {
  const bytes = await readFile(archive).catch(() => fail(`No archive at ${archive}`))
  const signature = JSON.parse(await readFile(archive + '.sig.json', 'utf8').catch(() => fail(`No signature at ${archive}.sig.json`)))
  try { verifyArchive(bytes, signature, keys) } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
  const manifest = archiveManifest(archive)
  const shipped = await Promise.all(features.map(async plugin => JSON.parse(await readFile(join(code, 'harness', plugin.name, 'package.json'), 'utf8')).name))
  if (!shipped.includes(manifest.name)) fail(`${manifest.name} is not one of Fig's feature packages`)
  if (manifest.fig?.base !== appVersion) console.warn(`Note: built for Fig ${manifest.fig?.base}; a Fig of another release deletes it at start.`)
  await mkdir(updatesRoot(into), { recursive: true })
  await copyFile(archive, join(updatesRoot(into), basename(archive)))
  await copyFile(archive + '.sig.json', join(updatesRoot(into), basename(archive) + '.sig.json'))
  console.log(`Placed ${manifest.name} ${manifest.version} in ${updatesRoot(into)}. It is used from Fig's next start.`)
}

/** The daily Fig's data folder: the one chosen in its settings, or ~/.fig. */
async function dailyHome() {
  const settings = await readFile(join(homedir(), 'Library/Application Support/Fig Desktop/directory-settings.json'), 'utf8').then(JSON.parse, () => ({}))
  return typeof settings?.dshHome === 'string' ? settings.dshHome : join(homedir(), '.fig')
}

/** Every file under `root`, relative. */
async function files(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(root, join(directory, entry.name))
    : Promise.resolve(entry.isFile() ? [relative(root, join(directory, entry.name))] : [])))
  return nested.flat()
}

const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex')

/** Files that differ between the build and the installed app's payload, added or removed included. */
async function differences(built, installed) {
  // The payload's own package.json is written at packaging (stageApplicationPayload), not built.
  const all = new Set([...await files(built), ...await files(installed)].filter(file => file !== 'package.json'))
  const changed = []
  for (const file of all) {
    const [a, b] = await Promise.all([digest(join(built, file)).catch(() => ''), digest(join(installed, file)).catch(() => '')])
    if (a !== b) changed.push(file)
  }
  return changed.sort()
}

/** A built package's content, its version left out, to tell whether this content was already shipped. */
async function contentHash(folder) {
  const hash = createHash('sha256')
  for (const file of (await files(folder)).sort()) {
    let bytes = await readFile(join(folder, file))
    if (file === 'package.json') bytes = Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), version: undefined }))
    hash.update(file + '\0').update(bytes)
  }
  return hash.digest('hex')
}

async function ship() {
  const app = resolve(option('app') ?? join(work, '../outputs/Fig Desktop.app'))
  const payload = join(app, 'Contents/Resources/app')
  const installed = JSON.parse(await readFile(join(payload, 'package.json'), 'utf8').catch(() => fail(`No Fig at ${app}; package the app first`))).version
  if (installed !== appVersion) fail(`需要整包：源码是 ${appVersion}，已安装的 Fig 是 ${installed}`)
  const into = option('home') ? home : await dailyHome()
  build()
  const changed = await differences(join(work, 'build'), payload)
  const featureOf = file => features.find(plugin => file.startsWith(`main/${plugin.name}/`))?.name
  const blockers = changed.filter(file => !featureOf(file))
  if (blockers.length) fail(`需要整包：插件以外的文件也有变化（${blockers.slice(0, 8).join('、')}${blockers.length > 8 ? ' 等 ' + blockers.length + ' 个' : ''}）`)
  const recordPath = join(work, 'plugin-packages/shipped.json')
  const record = await readFile(recordPath, 'utf8').then(JSON.parse, () => ({}))
  const shipped = record[installed] ?? {}
  const candidates = /** @type {string[]} */ ([...new Set(changed.map(featureOf))].filter(Boolean))
  const pending = []
  for (const name of candidates) if (shipped[name] !== await contentHash(join(work, 'build/main', name))) pending.push(name)
  if (!pending.length) { console.log(candidates.length ? '插件改动都已发过更新包，无需再发。' : '没有插件改动，无需打包。'); return }
  if (flag('dry-run')) { console.log('将发更新包：' + pending.join('、') + '；写入 ' + updatesRoot(into)); return }
  // Each shipped package gets the next patch version, kept in the source so later updates stay newer.
  for (const name of pending) {
    const path = join(code, 'harness', name, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    const [major, minor, patch] = manifest.version.split('.').map(Number)
    manifest.version = `${major}.${minor}.${patch + 1}`
    await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
  }
  build()
  const lines = []
  for (const name of pending) {
    await place(await packOne(name), into)
    shipped[name] = await contentHash(join(work, 'build/main', name))
    lines.push(`${name} ${JSON.parse(await readFile(join(work, 'build/main', name, 'package.json'), 'utf8')).version}`)
  }
  await writeFile(recordPath, JSON.stringify({ [installed]: shipped }, null, 2) + '\n')
  console.log(`插件已更新，重启 Fig 生效：${lines.join('、')}`)
}

async function placed() {
  return (await updateArchives(home)).map(file => ({ file, manifest: archiveManifest(join(updatesRoot(home), file)) }))
}

async function list() {
  const record = await readUpdateRecord(home)
  const items = await placed()
  if (!items.length) console.log(`No plugin updates in ${updatesRoot(home)}; Fig uses its built-in packages.`)
  for (const { file, manifest } of items) {
    const failed = record.failed[`${manifest.name}@${manifest.version}`]
    const used = record.active[manifest.name] === manifest.version
    console.log(`${file}  ${manifest.name} ${manifest.version} (Fig ${manifest.fig?.base})  ${used ? 'in use since the last start' : failed ? 'failed: ' + failed : 'not in use'}`)
  }
}

async function revert() {
  guardHome()
  const plugin = feature(target)
  const name = JSON.parse(await readFile(join(code, 'harness', plugin.name, 'package.json'), 'utf8')).name
  const removed = (await placed()).filter(item => item.manifest.name === name)
  for (const { file } of removed) {
    await rm(join(updatesRoot(home), file), { force: true })
    await rm(join(updatesRoot(home), file + '.sig.json'), { force: true })
  }
  console.log(removed.length ? `Removed ${removed.map(item => item.file).join(', ')}. Fig's next start uses the built-in ${plugin.name}.` : `No update of ${plugin.name} is placed.`)
}

const commands = { pack, install, list, revert, ship }
if (!commands[command]) fail('Usage: plugin-update.mjs pack|install|list|revert|ship ... (see the header of scripts/plugin-update.mjs)')
await commands[command]()

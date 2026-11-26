import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pnpmVersion } from '../app/main/pnpm-shim.ts'
import { dshReleasePattern } from '../harness/shared/dsh-range.ts'
import { figNpmCache } from '../harness/shared/npx-cache.js'
import { dshRuntimeRoot, ensureDshRuntime, installedRuntime, lockedRelease } from '../harness/shared/dsh-runtime.js'
import { npmCli } from './dsh-cache.mjs'

const defaultCode = fileURLToPath(new URL('..', import.meta.url))
export const licenseDirectory = 'main/third-party-licenses'
const configName = 'third-party-licenses.config.json'
const dshName = '@deepseek-ai/dsh'
const licenseName = /^(?:licen[cs]es?|licence|copying|unlicense)(?:$|[._-])/i
const noticeName = /^(?:notice|copyright|third[-_ ]?party[-_ ]?(?:licenses?|notices?))(?:$|[._-])/i
const categories = {
  fig: 'Fig Desktop • bundled npm dependencies',
  electron: 'Electron and its Chromium distribution',
  dsh: 'DSH and tools downloaded at runtime',
  adapted: 'Adapted source code',
  assets: 'Icons, wordmarks and fonts'
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const byName = (a, b) => a < b ? -1 : a > b ? 1 : 0
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char])

function readEvidence(path, label) {
  const bytes = existsSync(path) && readFileSync(path)
  if (!bytes || !bytes.toString('utf8').trim()) throw new Error(`Missing license or notice for ${label}: ${path}`)
  return bytes
}

function checkVersion(version) {
  if (!dshReleasePattern.test(version)) throw new Error('Expected a fixed DSH release version: ' + version)
  return version
}

/** Folders holding installs of locked DSH releases (shared/dsh-runtime.js): this tool's own, then the ones Fig runs. */
function cacheRoots(code, cache) {
  if (cache) return [resolve(cache)]
  return [resolve(code, '../work/license-npm-cache'), dshRuntimeRoot()]
}

/** The manifest and lockfile DSH `version` installs from: the candidate's (FIG_DSH_CANDIDATE_LOCK) when it pins `version`, else the committed one. */
function runtimeLock(code, version) {
  checkVersion(version)
  for (const folder of [process.env.FIG_DSH_CANDIDATE_LOCK, join(code, 'dsh-runtime')]) {
    if (!folder) continue
    const manifest = readJson(join(folder, 'package.json'))
    if (manifest.dependencies?.[dshName] === version) return { manifest, lock: readJson(join(folder, 'package-lock.json')) }
  }
  throw new Error(`No lockfile for DSH ${version}: run npm run dsh:verify -- ${version}`)
}

/** Install the locked DSH tree for the inventory, without install scripts. This command is never called by the build. */
export async function prepareLicenseCache(code = defaultCode, candidate, { cache = process.env.FIG_LICENSE_NPM_CACHE } = {}) {
  const target = cacheRoots(code, cache)[0]
  const versions = candidate ? [candidate] : readJson(join(code, 'harness/dsh-versions.json')).verified
  for (const version of versions) {
    await ensureDshRuntime({ ...runtimeLock(code, version), root: target, cache: figNpmCache(), ignoreScripts: true,
      node: process.execPath, npm: npmCli(), signal: AbortSignal.timeout(900_000) })
  }
  console.log('DSH npm tree installed from its lockfile: ' + target)
}

/** The install of `version`'s lockfile: its outer lock describes resolution, the hidden lock the actual installation. */
function installedDsh(code, version, cache) {
  const locked = runtimeLock(code, version)
  const release = lockedRelease(locked.manifest, locked.lock)
  const instruction = `Install it with npm run licenses:prepare -- ${version}`
  const found = cacheRoots(code, cache).map(root => installedRuntime(root, release)).find(Boolean)
  if (!found) throw new Error(`Missing DSH ${version} install. ${instruction}`)
  const workspace = found.folder, lock = locked.lock.packages
  const installedLock = join(workspace, 'node_modules/.package-lock.json')
  if (!existsSync(installedLock)) throw new Error(`Incomplete DSH ${version} install. ${instruction}`)
  const installed = readJson(installedLock).packages
  const paths = Object.keys(installed).sort(byName)
  for (const location of paths) {
    const { version, resolved, integrity } = installed[location]
    if (!lock[location] || [version, resolved, integrity].some((value, index) =>
      value !== [lock[location].version, lock[location].resolved, lock[location].integrity][index])) {
      throw new Error(`DSH npm lock mismatch: ${location}. ${instruction}`)
    }
    if (!existsSync(join(workspace, location, 'package.json'))) {
      throw new Error(`Missing DSH installed package: ${location}. ${instruction}`)
    }
  }
  for (const [location, entry] of Object.entries(lock)) {
    if (location && !installed[location] && (!entry.optional || existsSync(join(workspace, location, 'package.json')))) {
      throw new Error(`DSH npm installation does not match the lock: ${location}. ${instruction}`)
    }
  }
  const treeKey = digest(JSON.stringify(paths.map(path => [path, lock[path].version, lock[path].integrity])))
  return { workspace, lock, locations: paths, treeKey }
}

/** Release packages sometimes put the notices for embedded software below their own LICENSE. */
function packageNotices(root, nested) {
  const files = []
  function visit(folder, withinNotices = false) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      const marked = licenseName.test(entry.name) || noticeName.test(entry.name)
      if (entry.isFile() && (marked || withinNotices)) files.push(relative(root, path))
      if (nested && entry.isDirectory() && entry.name !== 'node_modules') visit(path, withinNotices || marked)
    }
  }
  visit(root)
  return files.sort(byName)
}

function runtimeVersions(code) {
  const electron = join(code, 'node_modules/electron')
  const binary = readEvidence(join(electron, 'path.txt'), 'Electron executable path').toString('utf8').trim()
  return JSON.parse(execFileSync(join(electron, 'dist', binary),
    ['-p', 'JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome })'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15_000 }))
}

/**
 * Generate the complete directory as Vite assets. Never resolve packages over the network.
 * Inputs use paths relative to `code/` except for npm caches and packaged native binaries.
 * @param {{code?: string, candidate?: string, cache?: string,
 *   electronVersions?: (code: string) => {electron: string, chrome: string}}} options
 */
export function generateThirdPartyLicenses({
  code = defaultCode, candidate, cache = process.env.FIG_LICENSE_NPM_CACHE, electronVersions = runtimeVersions
} = {}) {
  const config = readJson(join(code, configName))
  const files = new Map()
  const entries = []
  const figLocations = new Set()
  const templates = {}

  function attachment(bytes, name, source) {
    const sha256 = digest(bytes)
    const extension = /\.html?$/i.test(name) ? '.html' : '.txt'
    const path = 'texts/' + sha256 + extension
    files.set(path, bytes)
    return { name, path, source, sha256 }
  }
  function repoEvidence(file, label) {
    const bytes = readEvidence(resolve(code, file.path), label)
    if (file.sha256 && digest(bytes) !== file.sha256) throw new Error(`Changed license evidence for ${label}: ${file.path}`)
    return attachment(bytes, basename(file.path), file.source ?? file.path)
  }
  function spdx(expression, label) {
    const identifiers = expression?.match(/[\w.+-]+/g)?.filter(id => !['AND', 'OR', 'WITH'].includes(id)) ?? []
    if (!identifiers.length) throw new Error('Missing SPDX license for ' + label)
    for (const id of identifiers) {
      const template = config.spdx[id]
      if (!template) throw new Error(`Missing SPDX template for ${label}: ${id}`)
      templates[id] ??= repoEvidence(template, id)
    }
  }
  function npmEntry(category, workspace, location, locked, dshVersion) {
    const root = join(workspace, location)
    const pkg = readJson(join(root, 'package.json'))
    const label = `${pkg.name}@${pkg.version}`
    const expectedName = locked?.name ?? location.split('node_modules/').at(-1)
    if (pkg.name !== expectedName || pkg.version !== locked?.version || !locked.resolved || !locked.integrity ||
      (locked.license && locked.license !== pkg.license)) {
      throw new Error('Missing or mismatched npm lock metadata for ' + label)
    }
    spdx(pkg.license, label)
    const names = packageNotices(root, category === 'dsh')
    const documents = names.map(name => attachment(readEvidence(join(root, name), label), name, locked.resolved + '#package/' + name))
    const override = category === 'dsh' ? config.dshEvidence[label] : undefined
    if (override) {
      if (override.integrity !== locked.integrity || !override.files?.length) throw new Error('Mismatched license evidence for ' + label)
      for (const file of override.files) {
        if (file.packageFile) {
          const bytes = readEvidence(join(root, file.packageFile), label)
          if (digest(bytes) !== file.sha256) throw new Error('Changed native package notice for ' + label + ': ' + file.packageFile)
          if (!names.includes(file.packageFile)) documents.push(attachment(bytes, file.packageFile, file.source))
        } else documents.push(repoEvidence(file, label))
      }
    } else if (!names.some(name => name === basename(name) && licenseName.test(name))) {
      throw new Error('Missing license evidence for ' + label + ' (' + location + ')')
    }
    entries.push({ category, name: pkg.name, version: pkg.version, source: locked.resolved,
      integrity: locked.integrity, license: pkg.license, location, dshVersion, documents })
  }

  const figLock = readJson(join(code, 'package-lock.json')).packages
  // Production lock entries, plus reviewed devDependencies whose code is emitted in the app.
  for (const [location, pkg] of Object.entries(figLock)) {
    if (!location || (pkg.dev && !config.figBundledDev.includes(location))) continue
    npmEntry('fig', code, location, pkg)
    figLocations.add(location)
  }
  for (const location of config.figBundledDev) {
    if (!figLocations.has(location)) throw new Error('Bundled Fig dependency missing from the lock: ' + location)
  }

  const electron = figLock['node_modules/electron']
  const dist = join(code, 'node_modules/electron/dist')
  const actual = electronVersions(code)
  const manifest = readJson(join(dist, '../package.json'))
  if (actual.electron !== electron?.version || manifest.version !== electron.version || !actual.chrome) {
    throw new Error('Electron download does not match the Fig package lock')
  }
  const release = `https://github.com/electron/electron/releases/download/v${electron.version}/electron-v${electron.version}-${process.platform}-${process.arch}.zip`
  spdx(manifest.license, 'Electron')
  for (const { name, version, license, file } of [
    { name: 'Electron', version: electron.version, license: manifest.license, file: 'LICENSE' },
    { name: 'Chromium', version: actual.chrome, license: 'See Chromium credits', file: 'LICENSES.chromium.html' }
  ]) {
    entries.push({ category: 'electron', name, version, license, source: release,
      documents: [attachment(readEvidence(join(dist, file), name), file, release)] })
  }

  const verified = readJson(join(code, 'harness/dsh-versions.json')).verified
  const releases = [...new Set(candidate ? [...verified, candidate] : verified)]
  if (!releases.length) throw new Error('No verified DSH release in harness/dsh-versions.json')
  const dsh = {}
  for (const version of releases) {
    const { workspace, lock, locations, treeKey } = installedDsh(code, version, cache)
    dsh[version] = { resolvedTreeSha256: treeKey, installed: locations.length }
    for (const location of locations) npmEntry('dsh', workspace, location, lock[location], version)
  }

  for (const category of ['dsh', 'adapted', 'assets']) {
    for (const entry of config[category]) {
      const { inputs = [], files: evidence = [], ...meta } = entry
      const label = `${meta.name}@${meta.version}`
      if (!meta.source || !meta.version || !evidence.length) throw new Error('Incomplete license entry for ' + label)
      if (meta.license !== 'Fig Desktop brand asset') spdx(meta.license, label)
      for (const input of inputs) {
        const bytes = readEvidence(resolve(code, input.path), label)
        if (input.sha256 && digest(bytes) !== input.sha256) throw new Error(`Asset changed; recheck its license: ${input.path}`)
      }
      entries.push({ category, ...meta, documents: evidence.map(file => repoEvidence(file, label)) })
    }
  }
  if (!entries.some(entry => entry.category === 'dsh' && entry.name === 'pnpm' && entry.version === pnpmVersion)) {
    throw new Error('Missing license evidence for the pinned pnpm@' + pnpmVersion + ' fallback')
  }
  for (const [category, title] of Object.entries(categories)) {
    if (!entries.some(entry => entry.category === category)) throw new Error('Missing license category: ' + title)
  }

  const notice = readEvidence(resolve(code, '../NOTICE'), 'Fig Desktop NOTICE')
  files.set('NOTICE', notice)
  const platform = `${process.platform}-${process.arch}`
  entries.sort((a, b) => byName(a.name, b.name) || byName(a.version, b.version))
  files.set('manifest.json', JSON.stringify({ schema: 1, platform, dsh, templates, entries }, null, 2) + '\n')
  files.set('index.html', renderIndex(entries, platform, templates))
  return { files, figLocations }
}

function renderIndex(entries, platform, templates) {
  // Collapse repeated installations in the reader view. The manifest preserves every lock location.
  const seen = new Set()
  const sections = Object.entries(categories).map(([category, title]) => {
    const rows = []
    for (const entry of entries.filter(entry => entry.category === category)) {
      const key = JSON.stringify([category, entry.name, entry.version, entry.source, entry.documents])
      if (seen.has(key)) continue
      seen.add(key)
      const documents = entry.documents.map(doc =>
        `<a href="${doc.path}">${escape(doc.name)}</a> <span>(${escape(doc.source)})</span>`).join('<br>\n')
      rows.push(`<li><strong>${escape(entry.name)} ${escape(entry.version)}</strong> · ${escape(entry.license)}<br><span>${escape(entry.source)}</span><br>${documents}</li>`)
    }
    return `<h2>${escape(title)}</h2>\n<ul>${rows.join('\n')}</ul>`
  })
  const templateLinks = Object.keys(templates).sort(byName).map(id => `<a href="${templates[id].path}">${escape(id)}</a>`)
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Fig Desktop · 第三方许可证 / Third-Party Licenses</title>
<style>html{color-scheme:light dark}body{max-width:60rem;margin:2rem auto;padding:0 1rem;font:16px/1.55 system-ui;overflow-wrap:anywhere}li{margin:1rem 0}li span{font-size:.85em}a{color:LinkText}</style>
<h1>第三方许可证 / Third-Party Licenses</h1>
<p>Fig Desktop · ${escape(platform)} · <a href="NOTICE">NOTICE</a> · <a href="manifest.json">JSON manifest</a></p>
<p>The DSH entries describe the preloaded npm resolution used for this build. npm can resolve a different tree on a different platform or after a fresh install. System Node.js/npm, locally installed CLI tools and user-installed DSH plugins are supplied independently.</p>
${sections.join('\n')}
<h2>SPDX license texts</h2>
<p>${templateLinks.join(' · ')}</p>
</html>\n`
}

/** Fails if a build starts shipping code from a dependency the Fig table did not cover. */
export function checkFigModules(code, locations, moduleIds, imports = []) {
  for (const id of moduleIds) {
    const path = id.replace(/^\0/, '').split('?')[0]
    const injected = /^\0(rolldown|vite)\//.exec(id)
    if (injected && !locations.has('node_modules/' + injected[1])) {
      throw new Error('Unlisted build helper bundled into Fig: ' + injected[1])
    }
    if (!path.startsWith(code) || !relative(code, path).startsWith('node_modules/')) continue
    const match = relative(code, path).match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/)
    if (!match || !locations.has(match[1])) throw new Error('Unlisted npm module in Fig build: ' + id)
  }
  for (const id of imports) {
    if (id === 'electron' || isBuiltin(id)) continue
    throw new Error('Unlisted external module in Fig build: ' + id)
  }
}

export async function assertLicensePayload(app) {
  const root = join(app, licenseDirectory)
  for (const file of ['index.html', 'NOTICE']) readEvidence(join(root, file), 'app license payload')
  const { entries, templates } = readJson(join(root, 'manifest.json'))
  if (!Array.isArray(entries) || Object.keys(categories).some(category => !entries.some(entry => entry.category === category))) {
    throw new Error('Incomplete app license payload')
  }
  const documents = new Map([...entries.flatMap(entry => entry.documents), ...Object.values(templates)]
    .map(doc => [doc.path, doc.sha256]))
  for (const [path, sha256] of documents) {
    if (!/^texts\/[a-f0-9]{64}\.(?:txt|html)$/.test(path)) throw new Error('Invalid license payload path: ' + path)
    if (digest(await readFile(join(root, path))) !== sha256) throw new Error('App license payload does not match its manifest: ' + path)
  }
}

/** Shared by the packager and the isolated smoke for the same Resources/app layout. */
export async function stageApplicationPayload(build, app, { name, productName, version }) {
  await assertLicensePayload(build)
  await mkdir(dirname(app), { recursive: true })
  await cp(build, app, { recursive: true, verbatimSymlinks: true })
  await writeFile(join(app, 'package.json'), JSON.stringify({
    name, productName, version, private: true, type: 'module', main: 'main/index.js'
  }, null, 2) + '\n')
  await assertLicensePayload(app)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--prepare' || process.argv.length > 4) {
    throw new Error('Usage: npm run licenses:prepare -- [DSH version]')
  }
  await prepareLicenseCache(defaultCode, process.argv[3])
}

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { build as viteBuild, type Plugin } from 'vite'
import { dshCandidate, dshEngines } from './harness/dsh-versions'
import { figPlugins } from './harness/plugins'
import { checkFigModules, generateThirdPartyLicenses } from './scripts/third-party-licenses.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
// The Fig release a feature package is built with; a plugin update applies only to it (app/main/plugin-updates.ts).
const appVersion: string = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version
const verification = process.env.FIG_VERIFICATION_BUILD === '1'
const output = resolve(root, verification ? '../work/build-verification' : '../work/build')
// Host entries Rollup bundles together: the app, the host scripts of Fig's own packages (harness/plugins.ts, `bundle:
// false`) and the shared owned-agent runner, kept as its own file because it starts its supervisor by path. Feature
// packages (`bundle: true`) are built one by one instead (bundleHostEntry), so each can be packed and updated alone.
const hostEntries = {
  index: resolve(root, 'app/main/index.ts'),
  ...Object.fromEntries(figPlugins.filter(plugin => !plugin.bundle).flatMap(({ name, entries }) =>
    entries.map(entry => [name + '/' + entry, resolve(root, 'harness', name, entry + '.js')]))),
  'shared/owned-agent': resolve(root, 'harness/shared/owned-agent.js'),
  'shared/owned-agent-supervisor': resolve(root, 'harness/shared/owned-agent-supervisor.js')
}

async function bundlePageClient(entry: string, define: Record<string, string>) {
  // DSH loads each client as a classic script and supplies React through its module loader.
  const result = await viteBuild({
    configFile: false,
    logLevel: 'warn',
    define,
    build: { write: false, minify: false, lib: { entry, name: 'FigPagePlugin', formats: ['iife'] } }
  })
  const bundle = Array.isArray(result) ? result[0] : result
  if (!('output' in bundle) || bundle.output.length !== 1 || bundle.output[0].type !== 'chunk') {
    throw new Error('Expected one classic script for ' + entry)
  }
  return bundle.output[0]
}

const ownedAgent = resolve(root, 'harness/shared/owned-agent.js')
const ownedAgentSupervisor = resolve(root, 'harness/shared/owned-agent-supervisor.js')

/**
 * One feature package's host script as a single ES module with Fig's shared code inlined, so the package folder
 * imports nothing outside itself but Node's built-ins: it can then be packed and updated on its own.
 */
async function bundleHostEntry(entry: string, define: Record<string, string>) {
  const result = await viteBuild({
    configFile: false,
    logLevel: 'warn',
    define,
    ssr: { noExternal: true, target: 'node' },
    build: { write: false, minify: false, ssr: entry, rollupOptions: { output: { format: 'es', codeSplitting: false } } }
  })
  const bundle = Array.isArray(result) ? result[0] : result
  if (!('output' in bundle) || bundle.output.length !== 1 || bundle.output[0].type !== 'chunk') {
    throw new Error('Expected one host module for ' + entry)
  }
  const chunk = bundle.output[0]
  const outside = chunk.imports.filter(id => !id.startsWith('node:'))
  if (outside.length) throw new Error(`${entry} imports ${outside.join(', ')}; a feature package may import only Node built-ins`)
  return chunk
}

export default defineConfig(({ command }) => {
  let inventory: ReturnType<typeof generateThirdPartyLicenses> | undefined
  const licenses = () => inventory ??= generateThirdPartyLicenses({ code: root, candidate: dshCandidate() })
  const licenseAudit: Plugin = {
    name: 'fig-check-bundled-licenses',
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        const imports = [...output.imports, ...output.dynamicImports].filter(id => !Object.hasOwn(bundle, id))
        checkFigModules(root, licenses().figLocations, output.moduleIds, imports)
      }
    }
  }
  const mainDefine = { __FIG_VERIFICATION_BUILD__: JSON.stringify(verification), __FIG_DSH_CANDIDATE__: JSON.stringify(dshCandidate() ?? null) }
  return {
  main: {
    define: mainDefine,
    plugins: [licenseAudit, {
      name: 'fig-plugin-assets',
      async buildStart() {
        inventory = undefined
        for (const [file, source] of licenses().files) {
          this.emitFile({ type: 'asset', fileName: 'third-party-licenses/' + file, source })
        }
        const brandAssets = await Promise.all(Object.entries({
          // VI v0.4 bare symbol (墨 F / 米白 F), padded to a square viewBox; a light/dark pair so the
          // welcome mark stays visible on either canvas.
          __FIG_BRAND_ICON__: 'ui-logo.svg',
          __FIG_BRAND_ICON_DARK__: 'ui-logo-reverse.svg'
        }).map(async ([placeholder, file]) => {
          const path = resolve(root, '../assets/brand', file)
          this.addWatchFile(path)
          const url = 'data:image/svg+xml,' + encodeURIComponent(await readFile(path, 'utf8'))
          return [placeholder, JSON.stringify(url)] as const
        }))
        // Files DSH loads from each plugin directory (harness/plugins.ts).
        for (const { name: plugin, assets } of figPlugins) {
          for (const file of assets) {
            const path = resolve(root, 'harness', plugin, file)
            this.addWatchFile(path)
            if (file === 'client.js' || file === 'openai-catalog-bootstrap.js') {
              const chunk = file === 'client.js'
                ? await bundlePageClient(path, plugin === 'desktop-brand' ? Object.fromEntries(brandAssets) : {})
                : await bundleHostEntry(path, mainDefine)
              checkFigModules(root, licenses().figLocations, chunk.moduleIds, [...chunk.imports, ...chunk.dynamicImports])
              for (const module of chunk.moduleIds) this.addWatchFile(module)
              this.emitFile({ type: 'asset', fileName: plugin + '/' + file, source: chunk.code })
              continue
            }
            let source = await readFile(path, 'utf8')
            // `engines.dsh` follows harness/dsh-versions.json; DSH disables a plugin whose range misses it.
            if (file === 'package.json') {
              const manifest = JSON.parse(source)
              manifest.engines = { ...manifest.engines, dsh: dshEngines(dshCandidate()) }
              if (figPlugins.find(item => item.name === plugin)?.bundle) manifest.fig = { ...manifest.fig, base: appVersion }
              source = JSON.stringify(manifest, null, 2) + '\n'
            }
            this.emitFile({ type: 'asset', fileName: plugin + '/' + file, source })
          }
        }
        // Feature packages' host scripts, each self-contained. One that runs agents through owned-agent.js gets its
        // own copy of the supervisor, which owned-agent starts from beside itself.
        for (const { name: plugin, entries } of figPlugins.filter(item => item.bundle)) {
          let supervised = false
          for (const entry of entries) {
            const chunk = await bundleHostEntry(resolve(root, 'harness', plugin, entry + '.js'), mainDefine)
            checkFigModules(root, licenses().figLocations, chunk.moduleIds, chunk.imports)
            for (const module of chunk.moduleIds) this.addWatchFile(module)
            supervised ||= chunk.moduleIds.includes(ownedAgent)
            this.emitFile({ type: 'asset', fileName: plugin + '/' + entry + '.js', source: chunk.code })
          }
          if (supervised) this.emitFile({ type: 'asset', fileName: plugin + '/owned-agent-supervisor.js', source: await readFile(ownedAgentSupervisor, 'utf8') })
        }
      }
    }],
    build: {
      emptyOutDir: true,
      outDir: resolve(output, 'main'),
      rollupOptions: { input: hostEntries }
    }
  },
  preload: {
    plugins: [licenseAudit],
    build: {
      emptyOutDir: true,
      outDir: resolve(output, 'preload'),
      rollupOptions: {
        input: { index: resolve(root, 'app/preload/index.ts'), 'dsh-locale': resolve(root, 'app/preload/dsh-locale.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(root, 'app/renderer'),
    server: { fs: { allow: [root, resolve(root, '../assets/brand')] } },
    plugins: [react(), licenseAudit, {
      name: 'fig-csp',
      // The dev server needs inline scripts and its hot-reload socket; production builds allow neither.
      transformIndexHtml(html) {
        const serve = command === 'serve'
        return html
          .replace('__SCRIPT_POLICY__', serve ? "'self' 'unsafe-inline'" : "'self'")
          .replace('__CONNECT_POLICY__', serve ? "'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*" : "'self'")
      }
    }],
    build: {
      emptyOutDir: true,
      outDir: resolve(output, 'renderer'),
      rollupOptions: { input: resolve(root, 'app/renderer/index.html') }
    }
  }
  }
})

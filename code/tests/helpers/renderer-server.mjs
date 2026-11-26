import { resolveConfig } from 'electron-vite'
import { createServer } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const code = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// electron-vite --rendererOnly still launches Electron. Use its public renderer
// config with Vite directly so tests never start a second, non-isolated Fig instance.
export async function startRendererServer() {
  const resolved = await resolveConfig({ root: code }, 'serve', 'development')
  const renderer = resolved.config?.renderer
  if (!renderer) throw new Error('Renderer configuration is missing')
  const server = await createServer({ ...renderer, configFile: false,
    server: { ...renderer.server, host: '127.0.0.1', port: 0 } })
  try {
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('Renderer server did not publish its local URL')
    return { url, close: () => server.close() }
  } catch (error) { await server.close(); throw error }
}

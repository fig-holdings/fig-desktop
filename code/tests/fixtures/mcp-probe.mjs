// Minimal local MCP server for integration tests; no network or filesystem access.
import { createInterface } from 'node:readline'
for await (const line of createInterface({ input: process.stdin })) {
  let request
  try { request = JSON.parse(line) } catch { continue }
  if (request.id === undefined) continue
  let result
  switch (request.method) {
    case 'initialize': result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'audit', version: '1.0.0' } }; break
    case 'ping': result = {}; break
    case 'tools/list': result = { tools: [{ name: 'echo', description: 'Read-only harness test', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] }; break
    case 'tools/call': result = { content: [{ type: 'text', text: 'HARNESS-MCP-OK' }] }; break
    case 'resources/list': result = { resources: [{ uri: 'audit://probe', name: 'Probe', mimeType: 'text/plain' }] }; break
    case 'resources/templates/list': result = { resourceTemplates: [] }; break
    case 'resources/read': result = { contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'HARNESS-RESOURCE-OK' }] }; break
    default: console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } })); continue
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
}

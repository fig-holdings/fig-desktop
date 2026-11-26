// Models listed as supported_in_api in Codex's bundled catalog, missing from DSH rc.5.
export const openAI62Models = {
  'gpt-6.2-sol': { name: 'GPT-6.2 Sol', contextWindow: 500_000 },
  'gpt-6.2-astra': { name: 'GPT-6.2 Astra', contextWindow: 272_000 }
}

export function supplementOpenAIModels(catalog: Record<string, unknown>) {
  for (const [id, metadata] of Object.entries(openAI62Models)) {
    if (Object.hasOwn(catalog, id)) continue
    catalog[id] = {
      id, ...metadata, type: 'chat', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
      input: ['text', 'image'], reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      // rc.5 uses these same placeholders for unpriced models without a catalog output cap.
      maxTokens: 128_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }
  }
}

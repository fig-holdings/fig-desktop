import { loadPiAi } from '../shared/pi-ai.js'
import { fromDsh } from '../shared/dsh-plugin.js'
import { supplementOpenAIModels } from '../shared/openai-models.ts'
import { installNativeDiscovery } from './native-model-catalog.js'

try {
  const { piModule, PiAiAdapter, llm: { LlmRuntime, LlmError } } = await loadPiAi()
  const [{ OPENAI_MODELS: openai }, { XAI_MODELS: xai }, { credentialKey }] = await Promise.all([
    piModule('./providers/*', 'openai.models'), piModule('./providers/*', 'xai.models'), fromDsh('@deepseek-ai/dsh-credentials')
  ])
  supplementOpenAIModels(openai)
  installNativeDiscovery({ LlmRuntime, LlmError, PiAiAdapter, credentialKey, known: { openai, xai } })
} catch {
  console.warn('Fig could not install API model discovery. Using the installed DSH catalog.')
}

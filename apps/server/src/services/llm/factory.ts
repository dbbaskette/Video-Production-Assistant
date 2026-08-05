import type { LlmConfig } from '../../config.js';
import type { LlmClient } from './index.js';
import type { ModelEntry, ModelProvider } from './model-registry.js';
import type { ModelCapabilities } from '@vpa/shared';
import { createFakeLlm } from './fake.js';
import { createGeminiLlm } from './providers/gemini.js';
import { createAnthropicLlm } from './providers/anthropic.js';
import { createClaudeCodeLlm } from './providers/claude-code.js';
import { createCodexCliLlm } from './providers/codex-cli.js';
import { createOpenAICompatLlm } from './providers/openai-compat.js';

export function capabilitiesForProvider(provider: ModelProvider): ModelCapabilities {
  const isGemini = provider === 'gemini';
  return { text: true, image: isGemini, video: isGemini };
}

export function configuredReadiness(entry: ModelEntry): { ready: boolean; message?: string } {
  if (entry.provider === 'gemini' || entry.provider === 'anthropic') {
    return entry.apiKey
      ? { ready: true }
      : { ready: false, message: 'API key is missing' };
  }
  if (entry.provider === 'openai-compat' && !entry.endpoint) {
    return { ready: false, message: 'Endpoint is missing' };
  }
  return { ready: true };
}

/** Create an LlmClient from legacy env-based config (backward compat) */
export function createLlm(config: LlmConfig): LlmClient {
  switch (config.provider) {
    case 'claude-code':
      return createClaudeCodeLlm(config.model);
    case 'codex-cli':
      return createCodexCliLlm(config.model);
    case 'gemini':
      if (!config.apiKey) throw new Error('GEMINI_API_KEY is required when VPA_LLM_PROVIDER=gemini');
      return createGeminiLlm(config.apiKey, config.model);
    case 'anthropic':
      if (!config.apiKey) throw new Error('ANTHROPIC_API_KEY is required when VPA_LLM_PROVIDER=anthropic');
      return createAnthropicLlm(config.apiKey, config.model);
    case 'openai-compat':
      return createOpenAICompatLlm({
        endpoint: config.endpoint ?? 'http://localhost:1234/v1',
        model: config.model ?? 'default',
        apiKey: config.apiKey,
      });
    case 'fake':
      return createFakeLlm();
    default:
      throw new Error(`Unsupported LLM provider: ${String(config.provider)}`);
  }
}

/** Create an LlmClient from a ModelEntry (model registry) */
export function createLlmFromEntry(entry: ModelEntry): LlmClient {
  switch (entry.provider) {
    case 'claude-code':
      return createClaudeCodeLlm(entry.model);
    case 'codex-cli':
      return createCodexCliLlm(entry.model);
    case 'gemini':
      if (!entry.apiKey) throw new Error(`Gemini model "${entry.name}" has no API key configured`);
      return createGeminiLlm(entry.apiKey, entry.model);
    case 'anthropic':
      if (!entry.apiKey) throw new Error(`Anthropic model "${entry.name}" has no API key configured`);
      return createAnthropicLlm(entry.apiKey, entry.model);
    case 'openai-compat':
      if (!entry.endpoint) throw new Error(`OpenAI-compatible model "${entry.name}" has no endpoint configured`);
      return createOpenAICompatLlm({
        endpoint: entry.endpoint,
        model: entry.model,
        apiKey: entry.apiKey,
      });
    case 'fake':
      return createFakeLlm();
    default:
      throw new Error(`Unsupported LLM provider: ${String(entry.provider)}`);
  }
}

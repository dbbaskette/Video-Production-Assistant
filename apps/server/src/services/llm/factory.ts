import type { LlmConfig } from '../../config.js';
import type { LlmClient } from './index.js';
import type { ModelEntry } from './model-registry.js';
import { createFakeLlm } from './fake.js';
import { createGeminiLlm } from './providers/gemini.js';
import { createAnthropicLlm } from './providers/anthropic.js';
import { createClaudeCodeLlm } from './providers/claude-code.js';
import { createOpenAICompatLlm } from './providers/openai-compat.js';

/** Create an LlmClient from legacy env-based config (backward compat) */
export function createLlm(config: LlmConfig): LlmClient {
  switch (config.provider) {
    case 'claude-code':
      return createClaudeCodeLlm(config.model);
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
    default:
      return createFakeLlm();
  }
}

/** Create an LlmClient from a ModelEntry (model registry) */
export function createLlmFromEntry(entry: ModelEntry): LlmClient {
  switch (entry.provider) {
    case 'claude-code':
      return createClaudeCodeLlm(entry.model);
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
    default:
      return createFakeLlm();
  }
}

import type { LlmConfig } from '../../config.js';
import type { LlmClient } from './index.js';
import { createFakeLlm } from './fake.js';
import { createGeminiLlm } from './providers/gemini.js';
import { createAnthropicLlm } from './providers/anthropic.js';
import { createClaudeCodeLlm } from './providers/claude-code.js';

export function createLlm(config: LlmConfig): LlmClient {
  switch (config.provider) {
    case 'claude-code':
      // Uses `claude -p` subprocess — no API key required, uses your Claude subscription
      return createClaudeCodeLlm(config.model);
    case 'gemini':
      if (!config.apiKey) throw new Error('GEMINI_API_KEY is required when VPA_LLM_PROVIDER=gemini');
      return createGeminiLlm(config.apiKey, config.model);
    case 'anthropic':
      if (!config.apiKey) throw new Error('ANTHROPIC_API_KEY is required when VPA_LLM_PROVIDER=anthropic');
      return createAnthropicLlm(config.apiKey, config.model);
    case 'fake':
    default:
      return createFakeLlm();
  }
}

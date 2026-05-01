export interface LlmCompletion {
  text: string;
  raw?: unknown;
}

export interface LlmCompleteOptions {
  systemPrompt: string;
  userPrompt: string;
  responseFormat?: 'text' | 'json';
  temperature?: number;
  maxTokens?: number;
}

export interface LlmClient {
  complete(opts: LlmCompleteOptions): Promise<LlmCompletion>;
}

export { createFakeLlm } from './fake.js';
export { createLlm } from './factory.js';
export { loadPrompt } from './prompts.js';

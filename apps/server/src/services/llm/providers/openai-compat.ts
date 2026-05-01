/**
 * OpenAI-compatible provider.
 *
 * Works with LM Studio, Ollama, vLLM, LocalAI, or any server
 * that implements the OpenAI /v1/chat/completions endpoint.
 */

import type { LlmClient, LlmCompletion, LlmCompleteOptions } from '../index.js';

export interface OpenAICompatConfig {
  endpoint: string;   // e.g. "http://localhost:1234/v1"
  model: string;      // e.g. "qwen/qwen3.5-35b-a3b"
  apiKey?: string;     // optional — LM Studio doesn't require one
}

export function createOpenAICompatLlm(config: OpenAICompatConfig): LlmClient {
  const base = config.endpoint.replace(/\/+$/, '');

  return {
    async complete(opts: LlmCompleteOptions): Promise<LlmCompletion> {
      const messages: Array<{ role: string; content: string }> = [];

      if (opts.systemPrompt) {
        messages.push({ role: 'system', content: opts.systemPrompt });
      }

      let userContent = opts.userPrompt;
      if (opts.responseFormat === 'json') {
        userContent += '\n\nRespond with valid JSON only. No markdown fencing, no explanation.';
      }
      messages.push({ role: 'user', content: userContent });

      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        stream: false,
      };

      if (opts.temperature !== undefined) {
        body.temperature = opts.temperature;
      }
      if (opts.maxTokens !== undefined) {
        body.max_tokens = opts.maxTokens;
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (config.apiKey) {
        headers.authorization = `Bearer ${config.apiKey}`;
      }

      // Try with response_format first; if the server rejects it
      // (e.g. LM Studio only supports json_schema|text), retry without it.
      // The prompt already asks for JSON, so the model will comply either way,
      // and the two-pass conformance pipeline cleans up any issues.
      if (opts.responseFormat === 'json') {
        body.response_format = { type: 'json_object' };
      }

      let res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok && opts.responseFormat === 'json') {
        const errBody = await res.text();
        // If the server doesn't support json_object, retry without response_format
        if (errBody.includes('response_format') || errBody.includes('json_object')) {
          delete body.response_format;
          res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });
        } else {
          throw new Error(
            `OpenAI-compatible API error (${res.status} ${res.statusText}): ${errBody}`,
          );
        }
      }

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(
          `OpenAI-compatible API error (${res.status} ${res.statusText}): ${errBody}`,
        );
      }

      const json = (await res.json()) as Record<string, unknown>;
      const choices = json.choices as Array<Record<string, unknown>> | undefined;

      if (!choices || choices.length === 0) {
        throw new Error('OpenAI-compatible API returned no choices');
      }

      const message = choices[0]!.message as Record<string, unknown> | undefined;
      if (!message) {
        throw new Error('OpenAI-compatible API returned choice with no message');
      }

      const text = message.content as string | undefined;
      if (typeof text !== 'string') {
        throw new Error('OpenAI-compatible API returned message with no content');
      }

      return { text, raw: json };
    },
  };
}

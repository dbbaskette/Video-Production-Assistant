import type { LlmClient, LlmCompletion, LlmCompleteOptions } from '../index.js';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;
const API_VERSION = '2023-06-01';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

export function createAnthropicLlm(apiKey: string, model?: string): LlmClient {
  const resolvedModel = model ?? DEFAULT_MODEL;

  return {
    async complete(opts: LlmCompleteOptions): Promise<LlmCompletion> {
      let systemPrompt = opts.systemPrompt;

      // For JSON response format, instruct the model to return valid JSON
      if (opts.responseFormat === 'json') {
        systemPrompt += '\n\nYou must respond with valid JSON only, no markdown fencing.';
      }

      const body: Record<string, unknown> = {
        model: resolvedModel,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: opts.userPrompt,
          },
        ],
      };

      if (opts.temperature !== undefined) {
        body.temperature = opts.temperature;
      }

      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(
          `Anthropic API error (${res.status} ${res.statusText}): ${errBody}`,
        );
      }

      const json = (await res.json()) as Record<string, unknown>;

      // Extract text from content[0].text
      const content = json.content as Array<Record<string, unknown>> | undefined;
      if (!content || content.length === 0) {
        throw new Error('Anthropic API returned no content blocks');
      }

      const firstBlock = content[0]!;
      if (firstBlock.type !== 'text') {
        throw new Error(
          `Anthropic API returned unexpected content type: ${firstBlock.type}`,
        );
      }

      const text = firstBlock.text as string | undefined;
      if (typeof text !== 'string') {
        throw new Error('Anthropic API returned content block with no text');
      }

      return { text, raw: json };
    },
  };
}

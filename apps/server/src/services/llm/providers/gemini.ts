import type { LlmClient, LlmCompletion, LlmCompleteOptions } from '../index.js';

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

export function createGeminiLlm(apiKey: string, model?: string): LlmClient {
  const resolvedModel = model ?? DEFAULT_MODEL;

  return {
    async complete(opts: LlmCompleteOptions): Promise<LlmCompletion> {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent?key=${apiKey}`;

      const generationConfig: Record<string, unknown> = {};
      if (opts.responseFormat === 'json') {
        generationConfig.responseMimeType = 'application/json';
      }
      if (opts.temperature !== undefined) {
        generationConfig.temperature = opts.temperature;
      }
      if (opts.maxTokens !== undefined) {
        generationConfig.maxOutputTokens = opts.maxTokens;
      }

      const body: Record<string, unknown> = {
        system_instruction: {
          parts: [{ text: opts.systemPrompt }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: opts.userPrompt }],
          },
        ],
      };

      if (Object.keys(generationConfig).length > 0) {
        body.generationConfig = generationConfig;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(
          `Gemini API error (${res.status} ${res.statusText}): ${errBody}`,
        );
      }

      const json = (await res.json()) as Record<string, unknown>;

      // Extract text from candidates[0].content.parts[0].text
      const candidates = json.candidates as Array<Record<string, unknown>> | undefined;
      if (!candidates || candidates.length === 0) {
        throw new Error('Gemini API returned no candidates');
      }

      const content = candidates[0]!.content as Record<string, unknown> | undefined;
      if (!content) {
        throw new Error('Gemini API returned candidate with no content');
      }

      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (!parts || parts.length === 0) {
        throw new Error('Gemini API returned content with no parts');
      }

      const text = parts[0]!.text as string | undefined;
      if (typeof text !== 'string') {
        throw new Error('Gemini API returned part with no text');
      }

      return { text, raw: json };
    },
  };
}

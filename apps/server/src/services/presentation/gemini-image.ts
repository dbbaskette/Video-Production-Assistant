import { readFile } from 'node:fs/promises';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const GEMINI_IMAGE_TIMEOUT_MS = 60_000;
export const MAX_INLINE_IMAGE_BYTES = 12 * 1024 * 1024;

const MAX_SYSTEM_PROMPT_CHARS = 20_000;
const MAX_USER_PROMPT_CHARS = 30_000;
const MAX_MODEL_CHARS = 200;
const MAX_API_KEY_CHARS = 1_024;
const MAX_IMAGE_PATH_CHARS = 4_096;
const MAX_OUTPUT_TOKENS = 8_192;
const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface GenerateWithImageInput {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  imagePath: string;
  imageMimeType: 'image/png';
  responseMimeType: 'application/json';
  maxTokens: number;
}

export interface GeminiImageTransportLike {
  generateWithImage(input: GenerateWithImageInput): Promise<string>;
}

export class GeminiImageTransportError extends Error {
  readonly code = 'gemini_image_transport_failed';

  constructor() {
    super('Slide image analysis failed.');
    this.name = 'GeminiImageTransportError';
  }
}

export interface GeminiImageTransportOptions {
  fetch?: typeof fetch;
  readFile?: (path: string) => Promise<Buffer>;
}

function validText(value: string, maxChars: number): boolean {
  return value.length > 0 && value.length <= maxChars && value.trim().length > 0;
}

function validateInput(input: GenerateWithImageInput): void {
  if (
    !validText(input.apiKey, MAX_API_KEY_CHARS)
    || /\s/.test(input.apiKey)
    || !validText(input.model, MAX_MODEL_CHARS)
    || !SAFE_MODEL.test(input.model)
    || !validText(input.systemPrompt, MAX_SYSTEM_PROMPT_CHARS)
    || !validText(input.userPrompt, MAX_USER_PROMPT_CHARS)
    || !validText(input.imagePath, MAX_IMAGE_PATH_CHARS)
    || input.imagePath.includes('\0')
    || input.imageMimeType !== 'image/png'
    || input.responseMimeType !== 'application/json'
    || !Number.isSafeInteger(input.maxTokens)
    || input.maxTokens < 1
    || input.maxTokens > MAX_OUTPUT_TOKENS
  ) {
    throw new GeminiImageTransportError();
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new GeminiImageTransportError();
    }
  }

  if (!response.body) throw new GeminiImageTransportError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GeminiImageTransportError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function candidateText(value: unknown): string {
  if (typeof value !== 'object' || value === null) throw new GeminiImageTransportError();
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) throw new GeminiImageTransportError();
  const candidate = candidates[0];
  if (typeof candidate !== 'object' || candidate === null) throw new GeminiImageTransportError();
  const content = (candidate as { content?: unknown }).content;
  if (typeof content !== 'object' || content === null) throw new GeminiImageTransportError();
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts) || parts.length === 0) throw new GeminiImageTransportError();
  const firstPart = parts[0];
  if (typeof firstPart !== 'object' || firstPart === null) throw new GeminiImageTransportError();
  const text = (firstPart as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim().length === 0) throw new GeminiImageTransportError();
  return text;
}

export class GeminiImageTransport implements GeminiImageTransportLike {
  private readonly fetchRequest: typeof fetch;
  private readonly readImageFile: (path: string) => Promise<Buffer>;

  constructor(options: GeminiImageTransportOptions = {}) {
    this.fetchRequest = options.fetch ?? fetch;
    this.readImageFile = options.readFile ?? ((path) => readFile(path));
  }

  async generateWithImage(input: GenerateWithImageInput): Promise<string> {
    try {
      validateInput(input);
      const bytes = await this.readImageFile(input.imagePath);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
        throw new GeminiImageTransportError();
      }
      const encodedImage = bytes.toString('base64');
      const endpoint = new URL(`${GEMINI_API_BASE}/models/${encodeURIComponent(input.model)}:generateContent`);
      endpoint.searchParams.set('key', input.apiKey);
      const body = JSON.stringify({
        system_instruction: { parts: [{ text: input.systemPrompt }] },
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: input.imageMimeType, data: encodedImage } },
            { text: input.userPrompt },
          ],
        }],
        generationConfig: {
          responseMimeType: input.responseMimeType,
          maxOutputTokens: input.maxTokens,
        },
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GEMINI_IMAGE_TIMEOUT_MS);
      timeout.unref?.();
      try {
        const response = await this.fetchRequest(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
        if (!response.ok) throw new GeminiImageTransportError();
        return candidateText(await readBoundedJson(response));
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      throw new GeminiImageTransportError();
    }
  }
}

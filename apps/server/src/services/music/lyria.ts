/**
 * Google Lyria 3 music generation client.
 *
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent
 *
 * Uses the same Gemini API key (header: `x-goog-api-key`) that powers our
 * Gemini text + TTS providers. Two models available, both preview:
 *   - `lyria-3-clip-preview` — 30-second MP3, fast iteration
 *   - `lyria-3-pro-preview`  — ~2-minute MP3 (or WAV), full-length tracks
 *
 * One-shot, non-streaming, non-deterministic. SynthID-watermarked.
 *
 * Response: multi-part `candidates[0].content.parts[]`. We iterate and pick
 * the first part with `inline_data` containing the audio. Lyrics text parts
 * are exposed via the optional `lyrics` field on the result.
 *
 * https://ai.google.dev/gemini-api/docs/music-generation
 */

export type LyriaModel = 'clip' | 'pro';

const MODEL_IDS: Record<LyriaModel, string> = {
  clip: 'lyria-3-clip-preview',
  pro: 'lyria-3-pro-preview',
};

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface LyriaRequest {
  prompt: string;
  model: LyriaModel;
  /** 'audio/mp3' (default) or 'audio/wav' (Pro only). */
  format?: 'mp3' | 'wav';
}

export interface LyriaResult {
  audio: Buffer;
  mime: string;
  /** Lyrics or song-structure text returned alongside, if any. */
  lyrics?: string;
  /** The model id we actually called. */
  modelId: string;
}

export type LyriaErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'safety_blocked'
  | 'invalid_request'
  | 'no_audio'
  | 'unknown';

export class LyriaError extends Error {
  constructor(
    public readonly code: LyriaErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LyriaError';
  }
}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  inlineData?: { mimeType: string; data: string }; // tolerate camelCase variant
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

export async function generateMusic(req: LyriaRequest, apiKey: string): Promise<LyriaResult> {
  const modelId = MODEL_IDS[req.model];
  const format = req.format ?? 'mp3';
  if (format === 'wav' && req.model !== 'pro') {
    throw new LyriaError('invalid_request', 400, 'WAV output is only available on the Pro model');
  }
  const responseMimeType = format === 'wav' ? 'audio/wav' : 'audio/mp3';

  const body = {
    contents: [{ parts: [{ text: req.prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO', 'TEXT'],
      responseMimeType,
    },
  };

  const url = `${BASE_URL}/models/${encodeURIComponent(modelId)}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();

  if (!resp.ok) {
    const message = text.slice(0, 500) || `Lyria request failed (${resp.status})`;
    if (resp.status === 401 || resp.status === 403) {
      throw new LyriaError(resp.status === 401 ? 'unauthorized' : 'forbidden', resp.status, message);
    }
    if (resp.status === 429) {
      throw new LyriaError('rate_limited', resp.status, message);
    }
    if (resp.status >= 400 && resp.status < 500) {
      throw new LyriaError('invalid_request', resp.status, message);
    }
    throw new LyriaError('unknown', resp.status, message);
  }

  let parsed: GeminiResponse;
  try {
    parsed = JSON.parse(text) as GeminiResponse;
  } catch {
    throw new LyriaError('unknown', resp.status, 'Lyria response was not valid JSON');
  }

  if (parsed.promptFeedback?.blockReason) {
    throw new LyriaError(
      'safety_blocked',
      400,
      `Prompt blocked by safety filters: ${parsed.promptFeedback.blockReason}`,
    );
  }

  const parts = parsed.candidates?.[0]?.content?.parts ?? [];
  let audioBuffer: Buffer | null = null;
  let audioMime: string = responseMimeType;
  let lyrics: string | undefined;

  for (const part of parts) {
    const inline = part.inline_data ?? part.inlineData;
    if (inline?.data) {
      const mime = (part.inline_data?.mime_type ?? part.inlineData?.mimeType) ?? '';
      if (mime.startsWith('audio/') && !audioBuffer) {
        audioBuffer = Buffer.from(inline.data, 'base64');
        audioMime = mime;
      }
    } else if (part.text) {
      lyrics = lyrics ? `${lyrics}\n\n${part.text}` : part.text;
    }
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new LyriaError(
      'no_audio',
      resp.status,
      'Lyria returned no audio bytes. The prompt may have been refused without an explicit safety block.',
    );
  }

  return { audio: audioBuffer, mime: audioMime, lyrics, modelId };
}

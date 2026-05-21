/**
 * Minimal Gemini Files API client.
 *
 * Three-step flow for video-grounded generation:
 *   1. uploadVideo()        — resumable upload, returns the file resource (state: PROCESSING)
 *   2. waitForFileActive()  — poll until state === ACTIVE (or FAILED / timeout)
 *   3. generateWithVideo()  — generateContent with the file URI as a part
 *   4. deleteFile()         — best-effort cleanup (Gemini auto-expires after 48h anyway)
 *
 * Why a dedicated module instead of extending LlmClient: the existing
 * LlmClient interface is text-only by design — sending media would push
 * provider-specific shapes into a clean abstraction. This module is
 * Gemini-only and keeps the abstraction intact.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta';

export interface GeminiFile {
  /** "files/abc123def" */
  name: string;
  /** "https://generativelanguage.googleapis.com/v1beta/files/abc123def" */
  uri: string;
  mimeType: string;
  state: 'PROCESSING' | 'ACTIVE' | 'FAILED';
  expirationTime?: string;
  sizeBytes?: string;
}

/**
 * Upload a video (or any large file) using Gemini's resumable upload protocol.
 * The single-shot multipart endpoint is finicky for big files — resumable is
 * what the official SDKs use under the hood.
 *
 * Returns the file resource immediately after the bytes finish; the state will
 * usually be PROCESSING. Pass the result to waitForFileActive() before using.
 */
export async function uploadVideo(
  apiKey: string,
  filePath: string,
  mimeType: string,
  displayName?: string,
): Promise<GeminiFile> {
  const fileStat = await stat(filePath);
  const sizeBytes = fileStat.size;

  // Phase 1: initiate the upload — server allocates an upload URL.
  const initRes = await fetch(`${UPLOAD_BASE}/files?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(sizeBytes),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file: { display_name: displayName ?? basename(filePath) },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!initRes.ok) {
    const txt = await initRes.text();
    throw new Error(`Gemini Files API: upload init failed (${initRes.status}): ${txt}`);
  }
  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini Files API: init response missing x-goog-upload-url header');
  }

  // Phase 2: ship the bytes in a single PUT. For now we read the whole file
  // into memory — fine for typical scene recordings (tens of MB). If we ever
  // need to support multi-GB files we can chunk this.
  const bytes = await readFile(filePath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(sizeBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: bytes,
    signal: AbortSignal.timeout(3 * 60_000),
  });
  if (!uploadRes.ok) {
    const txt = await uploadRes.text();
    throw new Error(`Gemini Files API: upload bytes failed (${uploadRes.status}): ${txt}`);
  }
  const json = (await uploadRes.json()) as { file?: GeminiFile };
  if (!json.file) {
    throw new Error('Gemini Files API: upload response missing file resource');
  }
  return json.file;
}

/**
 * Poll a file resource until it transitions out of PROCESSING. Videos take
 * 5–30 seconds typically; we wait up to 5 minutes by default before giving up.
 */
export async function waitForFileActive(
  apiKey: string,
  fileName: string,
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    onPoll?: (state: GeminiFile['state']) => void;
  } = {},
): Promise<GeminiFile> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${API_BASE}/${fileName}?key=${apiKey}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Gemini Files API: poll failed (${res.status}): ${txt}`);
    }
    const file = (await res.json()) as GeminiFile;
    opts.onPoll?.(file.state);
    if (file.state === 'ACTIVE') return file;
    if (file.state === 'FAILED') {
      throw new Error('Gemini Files API: file processing FAILED');
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Gemini Files API: file ${fileName} did not become ACTIVE within ${timeoutMs}ms`);
}

/** Best-effort delete. Gemini auto-expires files after 48h, so failures are fine. */
export async function deleteFile(apiKey: string, fileName: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/${fileName}?key=${apiKey}`, { method: 'DELETE' });
  } catch {
    /* ignore — auto-expiry will clean up */
  }
}

export interface GenerateWithVideoInput {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** "https://generativelanguage.googleapis.com/v1beta/files/abc..." (from waitForFileActive). */
  videoFileUri: string;
  videoMimeType: string;
  temperature?: number;
  maxTokens?: number;
  responseMimeType?: 'text/plain' | 'application/json';
}

/**
 * Run generateContent with a video file part + a text prompt. Returns the
 * model's text output verbatim — caller is responsible for trimming /
 * parsing JSON if responseMimeType was application/json.
 */
export async function generateWithVideo(input: GenerateWithVideoInput): Promise<string> {
  const endpoint = `${API_BASE}/models/${input.model}:generateContent?key=${input.apiKey}`;

  const generationConfig: Record<string, unknown> = {};
  if (input.temperature !== undefined) generationConfig.temperature = input.temperature;
  if (input.maxTokens !== undefined) generationConfig.maxOutputTokens = input.maxTokens;
  if (input.responseMimeType) generationConfig.responseMimeType = input.responseMimeType;

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: input.systemPrompt }] },
    contents: [
      {
        role: 'user',
        parts: [
          { file_data: { mime_type: input.videoMimeType, file_uri: input.videoFileUri } },
          { text: input.userPrompt },
        ],
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
    signal: AbortSignal.timeout(3 * 60_000),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini generateContent failed (${res.status}): ${txt}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('Gemini generateContent: response missing candidates[0].content.parts[0].text');
  }
  return text;
}

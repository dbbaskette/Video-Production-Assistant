/**
 * xAI Custom Voices API client.
 *
 * Docs: https://docs.x.ai/developers/model-capabilities/audio/custom-voices
 *
 * Endpoints:
 *   POST   /v1/custom-voices              — multipart create (file ≤ 120 s, optional metadata)
 *   GET    /v1/custom-voices              — list
 *   GET    /v1/custom-voices/:voice_id    — retrieve
 *   PATCH  /v1/custom-voices/:voice_id    — update metadata
 *   DELETE /v1/custom-voices/:voice_id    — delete
 *
 * Auth: `Authorization: Bearer $XAI_API_KEY`.
 *
 * Creating voices via API requires Enterprise; this client surfaces 403 cleanly so
 * the UI can fall back to the manual-import or "clone via console" path.
 */

import type { VoiceClone } from '@vpa/shared';

const BASE_URL = 'https://api.x.ai/v1/custom-voices';

export type XaiVoiceErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'limit_reached'
  | 'bad_request'
  | 'unknown';

export class XaiVoiceError extends Error {
  constructor(
    public readonly code: XaiVoiceErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'XaiVoiceError';
  }
}

function classify(status: number, body: string): XaiVoiceError {
  const message = body.slice(0, 500) || `xAI custom-voices request failed (${status})`;
  switch (status) {
    case 400:
      return new XaiVoiceError(
        /limit/i.test(body) ? 'limit_reached' : 'bad_request',
        status,
        message,
      );
    case 401:
      return new XaiVoiceError('unauthorized', status, message);
    case 403:
      return new XaiVoiceError('forbidden', status, message);
    case 404:
      return new XaiVoiceError('not_found', status, message);
    default:
      return new XaiVoiceError('unknown', status, message);
  }
}

export interface XaiVoiceMetadata {
  name?: string;
  description?: string;
  gender?: VoiceClone['gender'];
  accent?: string;
  age?: VoiceClone['age'];
  language?: string;
  use_case?: VoiceClone['use_case'];
  tone?: VoiceClone['tone'];
}

export interface XaiVoiceRecord {
  voice_id: string;
  name?: string;
  description?: string;
  gender?: string;
  accent?: string;
  age?: string;
  language?: string;
  use_case?: string;
  tone?: string;
}

export class XaiVoiceClient {
  constructor(private readonly apiKey: string) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.apiKey}`);
    return fetch(`${BASE_URL}${path}`, { ...init, headers });
  }

  /**
   * Upload a reference audio buffer and create a custom voice. Returns the
   * server-assigned `voice_id` plus any echoed metadata.
   */
  async create(
    audio: { buffer: Buffer; filename: string; mime: string },
    metadata: XaiVoiceMetadata,
  ): Promise<XaiVoiceRecord> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(audio.buffer)], { type: audio.mime });
    form.append('file', blob, audio.filename);
    for (const [k, v] of Object.entries(metadata)) {
      if (v !== undefined && v !== null && v !== '') {
        form.append(k, String(v));
      }
    }
    const resp = await this.request('', { method: 'POST', body: form });
    const text = await resp.text();
    if (!resp.ok) throw classify(resp.status, text);
    const json = text ? (JSON.parse(text) as XaiVoiceRecord) : ({} as XaiVoiceRecord);
    if (!json.voice_id || typeof json.voice_id !== 'string') {
      throw new XaiVoiceError('unknown', resp.status, 'xAI response missing voice_id');
    }
    return json;
  }

  /** Confirm a voice_id exists (used after manual import to catch typos). */
  async exists(voice_id: string): Promise<boolean> {
    const resp = await this.request(`/${encodeURIComponent(voice_id)}`, { method: 'GET' });
    if (resp.status === 404) return false;
    if (!resp.ok) {
      const text = await resp.text();
      throw classify(resp.status, text);
    }
    return true;
  }

  async delete(voice_id: string): Promise<void> {
    const resp = await this.request(`/${encodeURIComponent(voice_id)}`, { method: 'DELETE' });
    if (resp.status === 404) return; // already gone
    if (!resp.ok) {
      const text = await resp.text();
      throw classify(resp.status, text);
    }
  }
}

/** Build the xAI console URL for the team's voice library, or a generic console URL. */
export function consoleVoiceLibraryUrl(teamId: string | undefined): { url: string; hasTeamId: boolean } {
  if (teamId && teamId.length > 0) {
    return {
      url: `https://console.x.ai/team/${encodeURIComponent(teamId)}/voice/voice-library?campaign=voice-docs-custom-voices`,
      hasTeamId: true,
    };
  }
  return { url: 'https://console.x.ai/', hasTeamId: false };
}

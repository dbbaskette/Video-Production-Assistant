/** TTS provider plugin interface. */

export interface TtsVoice {
  id: string;
  name: string;
  description?: string;
}

export interface TtsGenerateOpts {
  voice: string;
  speed?: number; // default 1.0
  /** Emotiveness level. Providers that support it (Gemini via style prompt)
   *  apply it here; xAI receives it already materialised as tags in the text,
   *  so it ignores this. fake/qwen ignore it. */
  expressiveness?: 'light' | 'medium' | 'heavy';
}

export interface TtsResult {
  audio: Buffer;
  timings?: Array<{ word: string; t: number }>;
  durationSec: number;
}

export interface TtsProvider {
  id: string;
  displayName: string;
  supportedEmotives: Set<string>;
  voices: TtsVoice[];
  generate(script: string, opts: TtsGenerateOpts): Promise<TtsResult>;
}

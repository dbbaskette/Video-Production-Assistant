/** TTS provider plugin interface. */

export interface TtsVoice {
  id: string;
  name: string;
  description?: string;
}

export interface TtsGenerateOpts {
  voice: string;
  speed?: number; // default 1.0
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

import type {
  TtsCapabilities,
  TtsProvider,
  TtsResult,
  TtsGenerateOpts,
  TtsVoice,
} from './provider.js';

export type { TtsCapabilities, TtsProvider, TtsResult, TtsGenerateOpts, TtsVoice };

export interface TtsEngineInfo {
  id: string;
  displayName: string;
  voices: TtsVoice[];
  supportedEmotives: string[];
  /** Real expressive tags the engine honors in the text (empty for engines
   *  with no inline markup). Drives the Narration-tab tag reference. */
  expressiveTags: string[];
  ready: true;
  capabilities: TtsCapabilities;
}

const LEGACY_CAPABILITIES: TtsCapabilities = {
  speed: { min: 1, max: 1, default: 1 },
  expressiveness: [],
  multiSpeaker: false,
  outputFormats: ['mp3'],
  timings: 'none',
  subtitles: false,
  maxInputChars: 5000,
};

export class TtsService {
  private providers = new Map<string, TtsProvider>();

  register(provider: TtsProvider): void {
    this.providers.set(provider.id, provider);
  }

  listEngines(): TtsEngineInfo[] {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      displayName: p.displayName,
      voices: p.voices,
      supportedEmotives: Array.from(p.supportedEmotives),
      expressiveTags: p.expressiveTags,
      ready: true,
      capabilities: p.capabilities ?? LEGACY_CAPABILITIES,
    }));
  }

  getProvider(engineId: string): TtsProvider | undefined {
    return this.providers.get(engineId);
  }

  getCapabilities(engineId: string): TtsCapabilities | undefined {
    const provider = this.providers.get(engineId);
    return provider ? provider.capabilities ?? LEGACY_CAPABILITIES : undefined;
  }

  async generate(engineId: string, script: string, opts: TtsGenerateOpts): Promise<TtsResult> {
    const provider = this.providers.get(engineId);
    if (!provider) {
      throw new Error(`TTS engine not found: ${engineId}`);
    }
    return provider.generate(script, opts);
  }

  /** Check which emotive tags in a script are unsupported by the given engine. */
  checkEmotives(engineId: string, script: string): string[] {
    const provider = this.providers.get(engineId);
    if (!provider) return [];

    const tags = [...script.matchAll(/\[([\w-]+)\]/g)].map((m) => m[1]!);
    return tags.filter((tag) => !provider.supportedEmotives.has(tag));
  }
}

export { createFakeTtsProvider } from './providers/fake.js';

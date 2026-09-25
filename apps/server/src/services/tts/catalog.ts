import type { TtsService } from './index.js';
import { VoiceCloneStore } from '../voice-clone/store.js';

/** Build the public TTS catalog shared by discovery and generation validation. */
export async function listAdvertisedTtsEngines(tts: TtsService, vpaHome: string) {
  const engines = tts.listEngines();
  let clones: Awaited<ReturnType<VoiceCloneStore['list']>> = [];
  try {
    clones = await new VoiceCloneStore({ vpaHome }).list();
  } catch {
    // A missing or unreadable clone store must not hide the built-in voices.
  }

  return engines.map((engine) => {
    if (engine.id === 'xai') {
      const cloneVoices = clones
        .filter((clone) => clone.providers.xai?.voice_id)
        .map((clone) => ({
          id: clone.providers.xai!.voice_id,
          name: `${clone.name} (cloned)`,
          description: 'Custom voice cloned via xAI',
        }));
      return { ...engine, voices: [...engine.voices, ...cloneVoices] };
    }
    if (engine.id === 'qwen') {
      const cloneVoices = clones
        .filter((clone) => clone.hasAudio)
        .map((clone) => ({
          id: `clone:${clone.id}`,
          name: `${clone.name} (cloned)`,
          description: 'Voice clone — uses your local recording',
        }));
      return { ...engine, voices: [...engine.voices, ...cloneVoices] };
    }
    return engine;
  });
}

# Plan 06 — TTS & Narration

**Goal:** Add text-to-speech narration generation for each scene. Users go to the Narration tab, choose a TTS engine and voice, click "Generate," and get an MP3 audio file plus SRT/VTT subtitle files. The narration service orchestrates: script → TTS → audio + word-level timings → subtitle files. All artifacts are saved to the project's `narration/` directory and referenced in `storyboard.yaml` under `scene.narration`.

**Architecture:** Builds on Plans 01–05. Adds a TTS provider plugin system (interface + fake provider for dev), a narration service that orchestrates TTS + subtitle generation, voice profile CRUD, narration routes, and updates the scene page Narration tab from placeholder to a functional UI with engine/voice selection, generate, playback, and subtitle preview.

**Tech Stack additions:** None for the fake provider. Real providers (Gemini, xAI, Kokoro) will be added later behind the same `TtsProvider` interface — the fake provider exercises the full pipeline for development and testing.

**Spec reference:** `docs/superpowers/specs/2026-04-29-vpa-phase1-design.md`, sections 2.3 (per-scene loop, narration tab), 3.3 (`ttsService`, `narrationService`, `voiceProfileService`), 3.4 (provider plugin shape), 5.4 (scene page narration pane).

---

## Task 1: TTS provider interface + fake provider

**Files:**
- Create: `apps/server/src/services/tts/provider.ts` — TTS provider interface
- Create: `apps/server/src/services/tts/providers/fake.ts` — fake TTS provider for dev/test
- Create: `apps/server/src/services/tts/index.ts` — TTS service (provider registry, engine listing)
- Create: `apps/server/src/services/tts/index.test.ts`

The `TtsProvider` interface:
```ts
interface TtsProvider {
  id: string;                           // 'fake' | 'gemini' | 'xai' | 'kokoro'
  displayName: string;
  supportedEmotives: Set<string>;
  voices: Array<{ id: string; name: string; description?: string }>;
  generate(script: string, opts: TtsGenerateOpts): Promise<TtsResult>;
}

interface TtsGenerateOpts {
  voice: string;
  speed?: number;                       // default 1.0
}

interface TtsResult {
  audio: Buffer;                        // raw audio bytes (MP3)
  timings?: Array<{ word: string; t: number }>;  // word-level timestamps
  durationSec: number;
}
```

The fake provider returns a minimal valid MP3 buffer (silence or a tiny sine wave generated inline — no external file dependency), fake word-level timings derived by splitting the script text and distributing timestamps evenly, and strips emotive tags from the script before "speaking."

The TTS service holds a registry of providers, exposes `listEngines()`, `getProvider(engineId)`, and `generate(engineId, script, opts)`.

---

## Task 2: Subtitle generation service

**Files:**
- Create: `apps/server/src/services/narration/subtitles.ts` — SRT + VTT generation from timings
- Create: `apps/server/src/services/narration/subtitles.test.ts`

Pure functions:
- `generateSrt(timings: Timing[], opts?: SubtitleOpts): string` — produces SRT format subtitle text
- `generateVtt(timings: Timing[], opts?: SubtitleOpts): string` — produces WebVTT format subtitle text

Both functions group words into subtitle cues (configurable max words per cue, default ~8 words), format timestamps in the appropriate format (SRT: `HH:MM:SS,mmm`, VTT: `HH:MM:SS.mmm`), and handle edge cases (empty timings, single word, emotive tags stripped from display text).

---

## Task 3: Narration orchestration service

**Files:**
- Create: `apps/server/src/services/narration/index.ts` — narration orchestrator
- Create: `apps/server/src/services/narration/index.test.ts`

The narration service orchestrates the full pipeline:
1. Validate that the scene has a script (error if not)
2. Call TTS provider with the script, chosen engine, voice, and speed
3. Write the audio buffer to `<projectRoot>/narration/scene-<id>.mp3`
4. Generate SRT and VTT subtitles from the TTS word-level timings
5. Write subtitle files to `<projectRoot>/narration/scene-<id>.srt` and `.vtt`
6. Update `storyboard.yaml` with narration metadata (audio path, subtitle paths, TTS config, timings)
7. Return the narration result (paths, duration, timing count)

Emotive tag handling: before sending to TTS, log a warning for any emotive tags not in the provider's `supportedEmotives` set (non-blocking — the call proceeds). Strip emotive tags from subtitle text but not from TTS input (providers that support them use them for prosody).

```ts
interface NarrationInput {
  projectPath: string;
  sceneId: string;
  engine: string;
  voice: string;
  speed?: number;
}

interface NarrationResult {
  audioPath: string;        // relative path: narration/scene-01.mp3
  srtPath: string;
  vttPath: string;
  durationSec: number;
  timingCount: number;
}
```

---

## Task 4: Voice profile service

**Files:**
- Create: `apps/server/src/services/voice-profile/index.ts` — voice profile CRUD
- Create: `apps/server/src/services/voice-profile/index.test.ts`

Voice profiles are YAML files in `~/.vpa/voices/`. Each profile bundles TTS engine + voice + style into a reusable preset:

```yaml
# ~/.vpa/voices/tanzu-narrator.yaml
name: Tanzu Narrator
engine: gemini
voice: Kore
speed: 1.0
description: "Default Tanzu demo voice — confident and clear"
```

Service API:
- `listProfiles(vpaHome: string): Promise<VoiceProfile[]>`
- `getProfile(vpaHome: string, profileId: string): Promise<VoiceProfile>`
- `saveProfile(vpaHome: string, profile: VoiceProfile): Promise<void>`
- `deleteProfile(vpaHome: string, profileId: string): Promise<void>`

A bundled default profile (`default-narrator`) is created on first access if no profiles exist.

---

## Task 5: Narration routes

**Files:**
- Create: `apps/server/src/routes/narration.ts`
- Create: `apps/server/src/routes/narration.test.ts`
- Modify: `apps/server/src/server.ts` — register narration routes

Routes:
- `GET /api/tts/engines` — list available TTS engines with their voices
- `GET /api/voices` — list voice profiles
- `POST /api/voices` — create voice profile
- `DELETE /api/voices/:profileId` — delete voice profile
- `POST /api/projects/:id/scenes/:sceneId/narration/generate` — generate narration (body: `{ engine, voice, speed? }`)
- `GET /api/projects/:id/scenes/:sceneId/narration` — get current narration state
- `GET /api/projects/:id/scenes/:sceneId/narration/audio` — stream the MP3 file (for playback)

---

## Task 6: Web API client + Narration tab UI

**Files:**
- Modify: `apps/web/src/lib/api.ts` — add narration + voice + TTS engine API methods
- Modify: `apps/web/src/pages/ScenePage.tsx` — replace Narration tab placeholder with functional UI

The Narration tab UI:
- **Empty state** (no narration yet): engine dropdown, voice dropdown, speed slider (0.5–2.0, default 1.0), Generate button. If no script exists, show a message directing user to the Script tab first.
- **After generation**: audio player (`<audio>` element with controls), subtitle preview (scrollable list of cues with timestamps), Regenerate button, engine/voice/speed controls for re-generation.
- **Loading state**: "Generating narration…" with a spinner during the TTS call.
- **Error state**: error message with retry button.

API client additions:
```ts
export const ttsApi = {
  listEngines(): Promise<TtsEngineInfo[]>,
};

export const voiceApi = {
  list(): Promise<VoiceProfile[]>,
  create(profile: CreateVoiceProfile): Promise<VoiceProfile>,
  remove(profileId: string): Promise<void>,
};

export const narrationApi = {
  get(projectId, sceneId): Promise<NarrationState>,
  generate(projectId, sceneId, opts): Promise<NarrationResult>,
  audioUrl(projectId, sceneId): string,  // returns URL for <audio src>
};
```

---

## Task 7: E2E test

**Files:**
- Create: `tests/e2e/narration.spec.ts`

E2E flow: create project → ideation → accept storyboard → navigate to scene → generate script → switch to Narration tab → select engine/voice → generate narration → verify audio player appears + subtitle preview visible.

---

## Dependencies

```
Task 1 (TTS provider) ──► Task 3 (narration service)
Task 2 (subtitles)    ──► Task 3 (narration service)
Task 4 (voice profiles) ──► Task 5 (routes)
Task 3 (narration service) ──► Task 5 (routes)
Task 5 (routes) ──► Task 6 (UI)
Task 6 (UI) ──► Task 7 (E2E)
```

Tasks 1, 2, and 4 can be implemented in parallel. Task 3 depends on 1+2. Task 5 depends on 3+4. Then 6 → 7.

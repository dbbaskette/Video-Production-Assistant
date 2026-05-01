# Plan 04 — Recording Ingestion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users upload MP4 recordings and attach them to storyboard scenes. Supports two flows: (1) multi-file upload where each MP4 maps to a scene, and (2) recording-first where uploading recordings generates a storyboard automatically from AI-generated scene descriptions. This plan also adds a Scene page shell with a Recording tab, plus video metadata extraction via ffprobe.

**Architecture:** Builds on Plans 01–03. Adds a recording metadata service (ffprobe wrapper), a recording ingestion service (file copy + storyboard update), multipart upload routes, a video analysis service stub (fake LLM for dev), and React UI for upload + scene recording tab. Single-file scene splitting (AI boundary detection + ffmpeg clip) is deferred to a follow-on plan — this plan covers multi-file upload only.

**Tech Stack additions** (on top of Plans 01-03):
- No new npm dependencies. Uses existing `@fastify/multipart` (already registered), `node:child_process` for ffprobe, existing LLM interface for video analysis.
- Runtime: requires `ffprobe` on PATH (part of ffmpeg).

**Spec reference:** `docs/superpowers/specs/2026-04-29-vpa-phase1-design.md`, sections 2.2 (recording-first), 2.3 (per-scene loop), 5.4 (scene page).

---

## File Structure (created or modified in this plan)

```
apps/server/src/
├── services/
│   ├── recording/
│   │   ├── metadata.ts                                  NEW — ffprobe wrapper for video metadata
│   │   ├── metadata.test.ts                             NEW
│   │   ├── ingest.ts                                    NEW — copy file to recordings/, update storyboard
│   │   └── ingest.test.ts                               NEW
│   ├── video-analysis/
│   │   ├── index.ts                                     NEW — analyze recording via LLM, generate description
│   │   └── index.test.ts                                NEW
│   └── llm/
│       └── fake.ts                                      MODIFY — add video analysis response
├── routes/
│   ├── recordings.ts                                    NEW — upload endpoint, metadata endpoint
│   └── recordings.test.ts                               NEW
└── server.ts                                            MODIFY — register recording routes

prompts/
└── scene-description.md                                 NEW — system prompt for video analysis

apps/web/src/
├── App.tsx                                              MODIFY — add scene route
├── lib/
│   └── api.ts                                           MODIFY — add recording API methods
├── pages/
│   ├── ProjectOverview.tsx                              MODIFY — add upload button, recording count
│   ├── StoryboardView.tsx                               MODIFY — show recording status per scene
│   └── ScenePage.tsx                                    NEW — scene detail with recording tab
├── components/
│   ├── ProjectSidebar.tsx                               MODIFY — scene links navigate to scene page
│   ├── RecordingUpload.tsx                              NEW — drag-drop / file picker for MP4s
│   └── RecordingInfo.tsx                                NEW — metadata display (duration, resolution)

tests/e2e/
└── recordings.spec.ts                                   NEW
```

---

## Task 1: Recording metadata service (ffprobe wrapper)

**Files:**
- Create: `apps/server/src/services/recording/metadata.ts`
- Create: `apps/server/src/services/recording/metadata.test.ts`

- [ ] **Step 1: Create `apps/server/src/services/recording/metadata.ts`**

  ```ts
  import { execFile } from 'node:child_process';
  import { promisify } from 'node:util';

  const execFileAsync = promisify(execFile);

  export interface VideoMetadata {
    duration_sec: number;
    width: number;
    height: number;
    codec: string;
    fps: number;
    size_bytes: number;
  }

  export async function probeVideo(filePath: string): Promise<VideoMetadata> {
    // Use ffprobe to extract format + stream info as JSON
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);
    const info = JSON.parse(stdout);
    const videoStream = info.streams?.find((s: any) => s.codec_type === 'video');
    if (!videoStream) throw new Error('No video stream found');

    const [num, den] = (videoStream.r_frame_rate ?? '30/1').split('/');
    const fps = den ? Number(num) / Number(den) : Number(num);

    return {
      duration_sec: parseFloat(info.format?.duration ?? videoStream.duration ?? '0'),
      width: videoStream.width ?? 0,
      height: videoStream.height ?? 0,
      codec: videoStream.codec_name ?? 'unknown',
      fps: Math.round(fps * 100) / 100,
      size_bytes: parseInt(info.format?.size ?? '0', 10),
    };
  }

  // Fake implementation for tests/dev when ffprobe is not available
  export function createFakeProbe(): typeof probeVideo {
    return async (_filePath: string) => ({
      duration_sec: 47.2,
      width: 1920,
      height: 1080,
      codec: 'h264',
      fps: 30,
      size_bytes: 15_000_000,
    });
  }
  ```

- [ ] **Step 2: Create metadata tests**
  Test `createFakeProbe` returns expected shape. Integration test for `probeVideo` gated behind `which ffprobe`.

---

## Task 2: Recording ingestion service

**Files:**
- Create: `apps/server/src/services/recording/ingest.ts`
- Create: `apps/server/src/services/recording/ingest.test.ts`

- [ ] **Step 1: Create `apps/server/src/services/recording/ingest.ts`**

  ```ts
  import { copyFile, mkdir } from 'node:fs/promises';
  import path from 'node:path';
  import { projectFiles } from '../project/paths.js';
  import { loadStoryboard, saveStoryboard, updateScene } from '../storyboard/index.js';
  import type { VideoMetadata } from './metadata.js';

  export interface IngestResult {
    sceneId: string;
    relativePath: string;      // e.g. 'recordings/scene-01.mp4'
    metadata: VideoMetadata;
  }

  // Copy uploaded file into project recordings dir, update storyboard scene
  export async function ingestRecording(
    projectRoot: string,
    sceneId: string,
    sourcePath: string,
    metadata: VideoMetadata,
  ): Promise<IngestResult> {
    const files = projectFiles(projectRoot);
    await mkdir(files.recordingsDir, { recursive: true });
    const destName = `${sceneId}.mp4`;
    const destPath = path.join(files.recordingsDir, destName);
    await copyFile(sourcePath, destPath);

    const relativePath = `recordings/${destName}`;

    // Update storyboard with recording info
    const sb = await loadStoryboard(projectRoot);
    if (sb) {
      const updated = updateScene(sb, sceneId, {
        recording: {
          source: relativePath,
          duration_sec: metadata.duration_sec,
          ingested_at: new Date().toISOString(),
        },
      });
      await saveStoryboard(projectRoot, updated);
    }

    return { sceneId, relativePath, metadata };
  }
  ```

- [ ] **Step 2: Write ingest tests** — creates temp dirs, copies a small test file, verifies storyboard updated.

---

## Task 3: Recording upload routes

**Files:**
- Create: `apps/server/src/routes/recordings.ts`
- Create: `apps/server/src/routes/recordings.test.ts`
- Modify: `apps/server/src/server.ts`

- [ ] **Step 1: Create `apps/server/src/routes/recordings.ts`**

  Routes:
  - `POST /api/projects/:id/scenes/:sceneId/recording` — multipart upload of single MP4 for a specific scene
  - `POST /api/projects/:id/recordings/bulk` — multipart upload of multiple MP4s; assigns to scenes by order or by filename match
  - `GET /api/projects/:id/scenes/:sceneId/recording/metadata` — returns probed metadata for scene's recording

- [ ] **Step 2: Write route integration tests** using Fastify inject() with multipart payloads.

- [ ] **Step 3: Register routes in server.ts**

---

## Task 4: Video analysis service (scene description from recording)

**Files:**
- Create: `apps/server/src/services/video-analysis/index.ts`
- Create: `apps/server/src/services/video-analysis/index.test.ts`
- Create: `prompts/scene-description.md`
- Modify: `apps/server/src/services/llm/fake.ts`

- [ ] **Step 1: Create scene-description prompt**
  System prompt instructing LLM to watch a recording and produce a scene name + description.

- [ ] **Step 2: Create video analysis service**
  For now, takes scene metadata and asks LLM to generate description. Real video analysis (Gemini video API) deferred to provider plan.

- [ ] **Step 3: Add fake LLM response for video analysis prompts**

- [ ] **Step 4: Write tests**

---

## Task 5: Recording-first storyboard generation

**Files:**
- Modify: `apps/server/src/routes/recordings.ts`

- [ ] **Step 1: Add `POST /api/projects/:id/recordings/generate-storyboard`**
  Takes uploaded recordings (already ingested), calls video analysis to generate descriptions, creates storyboard.yaml with scenes derived from recordings. Used by the "I have recordings" flow.

---

## Task 6: Web API client extensions

**Files:**
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Add recording API methods**
  ```ts
  export const recordingsApi = {
    uploadForScene(projectId, sceneId, file): Promise<IngestResult>,
    uploadBulk(projectId, files): Promise<IngestResult[]>,
    getMetadata(projectId, sceneId): Promise<VideoMetadata>,
    generateStoryboard(projectId): Promise<Storyboard>,
  };
  ```

---

## Task 7: Scene page shell + recording tab

**Files:**
- Create: `apps/web/src/pages/ScenePage.tsx`
- Create: `apps/web/src/components/RecordingInfo.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Create ScenePage.tsx**
  Scene detail page with tabs: Recording (active in this plan), Script (placeholder), Narration (placeholder), Lower Thirds (placeholder). Shows scene name, description, type badge.

- [ ] **Step 2: Create RecordingInfo.tsx**
  Displays video metadata: duration, resolution, codec, file size. Upload button if no recording. File picker for MP4.

- [ ] **Step 3: Add route in App.tsx**
  `<Route path="scene/:sceneId" element={<ScenePage />} />`

---

## Task 8: Upload UI + recording status in existing views

**Files:**
- Create: `apps/web/src/components/RecordingUpload.tsx`
- Modify: `apps/web/src/pages/ProjectOverview.tsx`
- Modify: `apps/web/src/pages/StoryboardView.tsx`
- Modify: `apps/web/src/components/ProjectSidebar.tsx`

- [ ] **Step 1: Create RecordingUpload.tsx**
  Drag-drop zone + file picker. Accepts multiple .mp4 files. Shows upload progress. Calls `recordingsApi.uploadBulk`.

- [ ] **Step 2: Update ProjectOverview.tsx**
  - Recording count card shows actual count from storyboard
  - Add "Upload Recordings" button that opens RecordingUpload

- [ ] **Step 3: Update StoryboardView.tsx**
  Recording status badges reflect actual recording presence.

- [ ] **Step 4: Update ProjectSidebar.tsx**
  Scene links navigate to `/project/:id/scene/:sceneId` instead of being static text.

---

## Task 9: E2E test

**Files:**
- Create: `tests/e2e/recordings.spec.ts`

- [ ] **Step 1: E2E test for recording-first flow**
  Create project → navigate to overview → verify recording UI elements exist → verify scene page loads.

---

## Dependencies

```
Task 1 (metadata) ──┐
                     ├──► Task 3 (routes) ──► Task 5 (generate storyboard)
Task 2 (ingest)  ───┘         │
                               ├──► Task 6 (API client) ──► Task 7 (scene page)
Task 4 (video analysis) ──────┘                              │
                                                              ├──► Task 8 (status UI)
                                                              └──► Task 9 (E2E)
```

Tasks 1, 2, and 4 are independent and can be built in parallel. Task 3 depends on 1+2. Tasks 6-9 are sequential.

# Presentation Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users upload a PDF presentation and receive one ordered, narratable VPA scene per page, with Gemini understanding each slide and the configured writing model drafting the spoken script.

**Architecture:** A presentation-specific service streams the PDF into project-local staging, validates and renders every page, creates short still-video sources, and atomically appends all scenes. Persisted presentation jobs and manifests make processing, restart recovery, retry, and removal explicit. AI runs only after deterministic import: the existing Gemini visual-model assignment produces cached slide briefs, then the writing assignment produces narration drafts without receiving image bytes.

**Tech Stack:** TypeScript, Zod, Fastify multipart streams, PDF.js, `@napi-rs/canvas`, FFmpeg, React 18, TanStack Query, Vitest, Playwright.

## Global Constraints

- The MVP accepts PDF files only; PowerPoint and Google Slides are not direct inputs.
- Default upload limits are exactly 100 MB and 200 pages, configurable by the local server.
- Every page is normalized to 1920x1080 at 30 fps using contain scaling and no cropping.
- The PDF path must not require LibreOffice, PowerPoint, Google authorization, or a system PDF utility.
- Every imported scene has `type: slide`, `recording.source_kind: presentation`, and server-generated relative asset paths.
- Deterministic processing is user-visible atomic: every page scene is appended or zero scenes are appended.
- The physical still clip is not the final scene duration; narration audio wins, otherwise `hold_duration_sec` defaults to five seconds.
- The existing persisted `video-understanding` assignment remains the compatibility key and supplies the Gemini image model; no fallback model is allowed.
- The configured `writing` assignment writes narration and never receives image bytes or a Gemini file URI.
- AI failure never removes imported scenes, and delayed AI output never overwrites a user-edited name, description, or script.
- Persisted project paths are relative, server-generated, and validated against traversal.
- Animations, PDF transitions, embedded audio, and embedded video become static slide visuals.

---

### Task 1: Shared presentation contracts and visual capability

**Files:**
- Create: `packages/shared/src/presentation.ts`
- Create: `packages/shared/src/presentation.test.ts`
- Modify: `packages/shared/src/storyboard.ts`
- Modify: `packages/shared/src/storyboard.test.ts`
- Modify: `packages/shared/src/model-routing.ts`
- Modify: `packages/shared/src/model-routing.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/services/llm/factory.ts`
- Modify: `apps/server/src/services/llm/factory.test.ts`
- Modify: `apps/server/src/services/llm/model-router.ts`
- Modify: `apps/server/src/services/llm/model-router.test.ts`
- Modify: `apps/server/src/routes/brands.test.ts`
- Modify: `apps/server/src/routes/ideation.test.ts`
- Modify: `apps/server/src/routes/lower-thirds.test.ts`
- Modify: `apps/server/src/routes/narration.test.ts`
- Modify: `apps/server/src/routes/quality-review.test.ts`
- Modify: `apps/server/src/routes/recordings.test.ts`
- Modify: `apps/server/src/routes/scripts.test.ts`
- Modify: `apps/server/src/routes/setup.test.ts`
- Modify: `apps/server/src/routes/shot-plan.test.ts`
- Modify: `apps/server/src/services/llm/model-registry.test.ts`
- Modify: `apps/server/src/services/video-understanding/index.test.ts`
- Modify: `apps/web/src/components/ModelAssignments.tsx`
- Modify: `apps/web/src/lib/model-routing.ts`
- Modify: `apps/web/src/lib/model-routing.test.ts`

**Interfaces:**
- Produces: `PresentationSource`, `PresentationJob`, `PresentationManifest`, `PresentationSlideBrief`, and `PresentationDraft` shared types.
- Produces: `ModelCapabilities.image: boolean` and `ModelRouter.resolveVisual(project?): Promise<ResolvedVisualModel>`.
- Preserves: `ModelRouter.resolveVideo()` and the persisted `video-understanding` role key.

- [ ] **Step 1: Write failing shared-schema tests**

Add tests that parse a valid imported scene and reject traversal, invalid page bounds, invalid hold durations, unbounded errors, and inconsistent page counts:

```ts
const source = {
  presentation_id: '1e570aa5-20ce-4779-ad9a-d4db3ae73991',
  page_number: 2,
  page_count: 3,
  image: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/pages/page-0002.png',
  hold_duration_sec: 5,
};

expect(PresentationSourceSchema.parse(source)).toEqual(source);
expect(PresentationSourceSchema.safeParse({ ...source, page_number: 4 }).success).toBe(false);
expect(PresentationSourceSchema.safeParse({ ...source, image: '../secret.png' }).success).toBe(false);
expect(PresentationSourceSchema.safeParse({ ...source, hold_duration_sec: 0 }).success).toBe(false);
expect(SceneSchema.parse({
  id: 'scene-slide-2',
  name: 'Architecture',
  description: 'Three services and their data flow.',
  type: 'slide',
  recording: {
    source: 'presentations/1e570aa5-20ce-4779-ad9a-d4db3ae73991/clips/page-0002.mp4',
    source_kind: 'presentation',
    duration_sec: 1,
  },
  presentation_source: source,
}).presentation_source).toEqual(source);
```

Define schema tests for these exact enums:

```ts
const jobStatuses = ['processing', 'ready', 'partial', 'failed'] as const;
const jobStages = [
  'uploading',
  'processing-slides',
  'creating-scenes',
  'drafting-narration',
  'ready',
  'failed',
] as const;
const pageAiStatuses = ['not-requested', 'pending', 'ready', 'failed', 'preserved-user-edit'] as const;
```

- [ ] **Step 2: Run the shared tests and verify the contracts are absent**

Run: `npm run build -w @vpa/shared && npm test -w @vpa/shared -- presentation storyboard model-routing`

Expected: FAIL because `PresentationSourceSchema`, the presentation source kind, and `image` capability do not exist.

- [ ] **Step 3: Implement the shared schemas and exports**

Create `presentation.ts` with these exported constants and schemas:

```ts
export const PRESENTATION_SCHEMA_VERSION = 1;
export const PRESENTATION_SLIDE_BRIEF_SCHEMA_VERSION = 1;
export const PRESENTATION_SLIDE_BRIEF_PROMPT_VERSION = 1;
export const PRESENTATION_NARRATION_PROMPT_VERSION = 1;

export const PresentationSourceSchema = z.object({
  presentation_id: z.string().uuid(),
  page_number: z.number().int().positive(),
  page_count: z.number().int().positive().max(200),
  image: SafeProjectRelativePathSchema,
  hold_duration_sec: z.number().min(1).max(3600).default(5),
}).strict().superRefine((value, ctx) => {
  if (value.page_number > value.page_count) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['page_number'],
      message: 'page_number must not exceed page_count',
    });
  }
});
```

Use one local `SafeProjectRelativePathSchema` that rejects absolute paths, empty segments, `.` segments, and `..` segments. Define the remaining schemas with strict, bounded fields:

```ts
export const PresentationPageRecordSchema = z.object({
  page_number: z.number().int().positive(),
  scene_id: z.string().min(1).max(120),
  image: SafeProjectRelativePathSchema,
  clip: SafeProjectRelativePathSchema,
  extracted_text: z.string().max(20_000),
  baseline: z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(4_000),
    narration_script: z.null(),
  }).strict(),
  analysis_status: z.enum(pageAiStatuses),
  script_status: z.enum(pageAiStatuses),
  brief: SafeProjectRelativePathSchema.optional(),
  draft: SafeProjectRelativePathSchema.optional(),
}).strict();
```

`PresentationManifestSchema` must contain version, UUID, project UUID, display name capped at 255 characters, 64-character lowercase SHA-256, positive byte size, timestamps, `generate_narration`, model provenance, and an ordered non-empty page array whose page numbers are exactly 1..N. Define the persisted job with these exact fields:

```ts
export const PresentationJobSchema = z.object({
  schema_version: z.literal(PRESENTATION_SCHEMA_VERSION),
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  status: z.enum(jobStatuses),
  stage: z.enum(jobStages),
  generate_narration: z.boolean(),
  page_count: z.number().int().nonnegative().max(200),
  processed_pages: z.number().int().nonnegative().max(200),
  analyzed_pages: z.number().int().nonnegative().max(200),
  scripted_pages: z.number().int().nonnegative().max(200),
  remaining_scene_count: z.number().int().nonnegative().max(200),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  error: z.object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(300),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  for (const field of ['processed_pages', 'analyzed_pages', 'scripted_pages'] as const) {
    if (value[field] > value.page_count) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} exceeds page_count` });
    }
  }
});
```

`PresentationSlideBriefSchema` must include source hashes, Gemini model provenance, visual summary, detected title, key points, visual elements, quantitative claims, and uncertain content. `PresentationDraftSchema` must include page number, brief fingerprint, writing-model provenance, script capped at 12,000 characters, created timestamp, and `applied`.

Export every inferred type and re-export `presentation.ts` from `index.ts`. Extend `RecordingSchema.source_kind` with `presentation`, add optional `presentation_source: PresentationSourceSchema` to `SceneSchema`, and require both presentation fields together in a `superRefine` check.

- [ ] **Step 4: Add image capability without changing role persistence**

Extend `ModelCapabilitiesSchema` with `image: z.boolean()`. Return this exact capability mapping:

```ts
export function capabilitiesForProvider(provider: ModelProvider): ModelCapabilities {
  const isGemini = provider === 'gemini';
  return { text: true, image: isGemini, video: isGemini };
}
```

Add `ResolvedVisualModel` with the same shape as `ResolvedVideoModel`, and implement:

```ts
async resolveVisual(project?: Project): Promise<ResolvedVisualModel> {
  const role = 'video-understanding' as const;
  const { entry, scope } = this.selectedEntry(role, project);
  const capabilities = capabilitiesForProvider(entry.provider);
  if (entry.provider !== 'gemini' || !capabilities.image) {
    throw routingError('model_capability_mismatch', role, scope);
  }
  await this.requireReady(role, scope, entry);
  if (!entry.apiKey) throw routingError('model_unavailable', role, scope);
  return {
    apiKey: entry.apiKey,
    model: entry.model,
    summary: { ...summaryFor(role, scope, entry, capabilities), provider: 'gemini' },
  };
}
```

Keep `resolveVideo()` as the video-capability equivalent. Change the assignment row label to **Understand visual media**, helper text to **Creates visual and timing briefs from recordings and presentation slides.**, display an `Image` capability badge, and filter the visual role to Gemini models with both `image` and `video` capability.

Update every existing typed capability fixture listed in this task: Gemini gets `{ text: true, image: true, video: true }`; every other provider gets `{ text: true, image: false, video: false }`. Run `rg -n "capabilities:\\s*\\{" packages apps tests` and leave no old two-field fixture.

- [ ] **Step 5: Run the shared, router, and web view-model tests**

Run: `npm run build -w @vpa/shared && npm test -w @vpa/shared && npm test -w @vpa/server -- src/services/llm/factory.test.ts src/services/llm/model-router.test.ts && npm test -w @vpa/web -- src/lib/model-routing.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the contracts**

```bash
git add packages/shared/src apps/server/src/services/llm apps/server/src/services/video-understanding/index.test.ts apps/server/src/routes/brands.test.ts apps/server/src/routes/ideation.test.ts apps/server/src/routes/lower-thirds.test.ts apps/server/src/routes/narration.test.ts apps/server/src/routes/quality-review.test.ts apps/server/src/routes/recordings.test.ts apps/server/src/routes/scripts.test.ts apps/server/src/routes/setup.test.ts apps/server/src/routes/shot-plan.test.ts apps/web/src/components/ModelAssignments.tsx apps/web/src/lib/model-routing.ts apps/web/src/lib/model-routing.test.ts
git commit -m "feat(presentations): add shared import contracts"
```

---

### Task 2: Bounded PDF inspection, page rendering, and still clips

**Files:**
- Modify: `apps/server/package.json`
- Modify: `package-lock.json`
- Create: `apps/server/src/services/presentation/pdf.ts`
- Create: `apps/server/src/services/presentation/pdf.test.ts`
- Create: `apps/server/src/services/presentation/media.ts`
- Create: `apps/server/src/services/presentation/media.test.ts`

**Interfaces:**
- Produces: `inspectPdf(sourcePath, limits): Promise<PdfInspection>`.
- Produces: `renderPdfPage(page, destination): Promise<void>` through `PdfPageHandle.render`.
- Produces: `createSlideAssets(input, runFfmpeg?): Promise<void>`.
- Consumes: `runFfmpeg(args)` from the existing render service only through an injected runner.

- [ ] **Step 1: Add PDF and canvas dependencies**

Run:

```bash
npm install -w @vpa/server pdfjs-dist @napi-rs/canvas
npm install -D -w @vpa/server pdf-lib
```

Expected: `apps/server/package.json` and `package-lock.json` record all three packages.

- [ ] **Step 2: Write failing PDF inspection and rendering tests**

Use `pdf-lib` inside the test to create a two-page PDF with headings `Overview` and `Architecture`. Assert:

```ts
const inspected = await inspectPdf(pdfPath, { maxPages: 200, maxTextCharsPerPage: 20_000 });
expect(inspected.pageCount).toBe(2);
expect(inspected.pages.map((page) => page.heading)).toEqual(['Overview', 'Architecture']);
expect(inspected.pages[0]?.text).toContain('Overview');

await inspected.pages[0]!.render(rawPngPath);
const image = await readFile(rawPngPath);
expect(image.subarray(1, 4).toString()).toBe('PNG');
await inspected.close();
```

Add cases for a page with no text (`heading === undefined`), rotated portrait pages, a 201-page document rejected with `page_limit_exceeded`, encrypted/invalid bytes rejected with `invalid_pdf`, and a page whose extracted text is truncated at exactly 20,000 characters.

- [ ] **Step 3: Run the PDF tests and verify failure**

Run: `npm test -w @vpa/server -- src/services/presentation/pdf.test.ts`

Expected: FAIL because the PDF service does not exist.

- [ ] **Step 4: Implement the PDF.js adapter**

Create these exact public types:

```ts
export interface PdfLimits {
  maxPages: number;
  maxTextCharsPerPage: number;
}

export interface PdfPageHandle {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  text: string;
  heading?: string;
  render(destination: string): Promise<void>;
}

export interface PdfInspection {
  pageCount: number;
  pages: PdfPageHandle[];
  close(): Promise<void>;
}
```

Load with `getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true })`. Build page text from `getTextContent()` items containing a string, preserving line breaks when Y positions change. Choose the first trimmed line between 1 and 160 characters as the heading. Render with `@napi-rs/canvas` at a scale that keeps both dimensions at or below 1920x1080, never allocate from unscaled hostile dimensions, fill the raw canvas white, and write PNG bytes with mode `0o600`. Map password, parse, and page-limit failures to `PresentationPdfError` codes `encrypted_pdf`, `invalid_pdf`, and `page_limit_exceeded`.

- [ ] **Step 5: Write failing media-command tests**

Inject a fake FFmpeg runner and assert the first pass uses this visual graph and the second creates a one-second silent clip:

```ts
expect(calls[0]).toContain(
  '[0:v]split=2[front][back];[back]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=20:1,eq=brightness=-0.15[bg];[front]scale=1920:1080:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgba[out]',
);
expect(calls[1]).toEqual(expect.arrayContaining([
  '-loop', '1', '-framerate', '30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
]));
```

- [ ] **Step 6: Implement normalized image and clip generation**

Export:

```ts
export type FfmpegRunner = (args: string[]) => Promise<void>;

export async function createSlideAssets(input: {
  rawPagePath: string;
  imagePath: string;
  clipPath: string;
}, run: FfmpegRunner = runFfmpeg): Promise<void>;
```

Create parent directories, run the exact normalization graph from the test, write a 1920x1080 PNG, then create a one-second 30 fps H.264/yuv420p/no-audio MP4 with `+faststart`. Remove either output if its FFmpeg pass fails so callers never see a half-valid page.

- [ ] **Step 7: Run the presentation media tests**

Run: `npm test -w @vpa/server -- src/services/presentation/pdf.test.ts src/services/presentation/media.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the PDF pipeline**

```bash
git add apps/server/package.json package-lock.json apps/server/src/services/presentation/pdf.ts apps/server/src/services/presentation/pdf.test.ts apps/server/src/services/presentation/media.ts apps/server/src/services/presentation/media.test.ts
git commit -m "feat(presentations): render PDF pages into slide media"
```

---

### Task 3: Persisted jobs and atomic scene import

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/services/project/paths.ts`
- Modify: `apps/server/src/services/project/paths.test.ts`
- Modify: `apps/server/src/services/storyboard/index.ts`
- Modify: `apps/server/src/services/storyboard/index.test.ts`
- Modify: `apps/server/src/routes/storyboard.ts`
- Modify: `apps/server/src/routes/storyboard.test.ts`
- Modify: `apps/server/src/routes/scripts.ts`
- Modify: `apps/server/src/routes/scripts.test.ts`
- Create: `apps/server/src/services/presentation/job-store.ts`
- Create: `apps/server/src/services/presentation/job-store.test.ts`
- Create: `apps/server/src/services/presentation/import-service.ts`
- Create: `apps/server/src/services/presentation/import-service.test.ts`

**Interfaces:**
- Produces: `mutateStoryboard(projectRoot, transform): Promise<Storyboard>`.
- Produces: `PresentationJobStore` CRUD backed by `presentation-jobs/<id>.json`.
- Produces: `PresentationImportService.registerUpload`, `.process`, `.retryImport`, `.list`, `.get`, and `.remove`.
- Consumes: Task 2 `inspectPdf` and `createSlideAssets`.

- [ ] **Step 1: Write failing config and project-path tests**

Assert default limits and new directories:

```ts
expect(loadConfig({} as NodeJS.ProcessEnv).presentation).toEqual({
  maxBytes: 100 * 1024 * 1024,
  maxPages: 200,
});
expect(projectFiles('/project')).toMatchObject({
  presentationsDir: '/project/presentations',
  presentationJobsDir: '/project/presentation-jobs',
  presentationStagingDir: '/project/.presentation-staging',
});
```

Add invalid environment cases for zero, negative, fractional, and unsafe values in `VPA_PRESENTATION_MAX_BYTES` and `VPA_PRESENTATION_MAX_PAGES`.

- [ ] **Step 2: Implement presentation configuration and paths**

Add `presentation: { maxBytes: number; maxPages: number }` to `ServerConfig`. Parse the two environment variables as positive safe integers, using exact defaults from Step 1. Add the three project paths to `ProjectFiles`.

- [ ] **Step 3: Write failing serialized-storyboard mutation tests**

Start two mutations against the same project. Hold the first with a deferred promise, start the second, then release the first. Assert the second sees the first mutation and the final storyboard contains both scenes. Also assert mutations for two different project roots can overlap.

Use this signature:

```ts
await mutateStoryboard(projectRoot, (current) => {
  const base = current ?? createStoryboard(project, []);
  return { ...base, scenes: [...base.scenes, scene] };
});
```

- [ ] **Step 4: Implement `mutateStoryboard`**

Add a module-local `Map<string, Promise<void>>` queue in the storyboard service. Serialize the complete load-transform-validate-save operation per resolved project root, clean the queue tail in `finally`, and pass `Storyboard | null` to the transform. Do not change existing `loadStoryboard` and `saveStoryboard` signatures.

Convert every mutating handler in `routes/storyboard.ts` to perform its
load-transform-save work inside `mutateStoryboard`, including full save, add,
reorder, scene update/delete, defaults, and per-scene frame settings. Move file
cache deletion after the persisted mutation and derive its paths from the
pre-mutation scene captured inside the callback. Convert the user-authored
intent and script PUT handlers in `routes/scripts.ts` to the same helper. Add a
route test that holds an import append mutation, queues a scene-name edit, and
asserts the final storyboard contains both the append and the edited name.

- [ ] **Step 5: Write failing persisted-job tests**

Test create/read/update/list, atomic writes, schema rejection, bounded public errors, and safe deletion. A job ID must be validated as UUID before joining a path. Reading a missing job returns `null`; listing ignores unrelated files and rejects malformed `.json` records with a private diagnostic callback rather than returning unvalidated data.

- [ ] **Step 6: Implement `PresentationJobStore`**

Use this public surface:

```ts
export class PresentationJobStore {
  constructor(private readonly options: {
    warn: (fields: Record<string, unknown>, message: string) => void;
    persist?: typeof atomicWriteFile;
  }) {}

  create(projectPath: string, job: PresentationJob): Promise<PresentationJob>;
  read(projectPath: string, id: string): Promise<PresentationJob | null>;
  update(projectPath: string, id: string, patch: Partial<PresentationJob>): Promise<PresentationJob>;
  list(projectPath: string): Promise<PresentationJob[]>;
  delete(projectPath: string, id: string): Promise<void>;
}
```

Validate the merged object on every update, force `id` and `project_id` to remain unchanged, update `updated_at`, and sort lists newest first.

- [ ] **Step 7: Write failing import-service tests**

Inject fake PDF and media adapters. Cover:

- Three pages create exactly three ordered `slide` scenes.
- The first bounded heading becomes the name; blank headings fall back to `Slide 2`.
- Existing scenes remain ahead of imported scenes.
- A project without a storyboard gets `createStoryboard(project, scenes)`.
- Page images and clips use zero-padded relative paths inside one presentation UUID.
- A page/media failure commits zero scenes and removes partial page assets.
- A storyboard-save failure leaves no scene references and a recoverable unreferenced final bundle.
- A concurrent `mutateStoryboard` edit is present after append.
- Retry reuses only a retained valid source PDF and rejects validation failures with `source_not_available`.
- Re-importing identical SHA-256 bytes creates an independent UUID and scenes.

- [ ] **Step 8: Implement deterministic import processing**

Use these inputs:

```ts
export interface RegisterPresentationUploadInput {
  project: Project;
  id: string;
  filename: string;
  stagedSourcePath: string;
  sizeBytes: number;
  generateNarration: boolean;
}

export class PresentationImportService {
  registerUpload(input: RegisterPresentationUploadInput): Promise<PresentationJob>;
  process(project: Project, id: string): Promise<PresentationJob>;
  retryImport(project: Project, id: string): Promise<PresentationJob>;
  list(projectPath: string): Promise<PresentationJob[]>;
  get(projectPath: string, id: string): Promise<PresentationJob | null>;
  remove(project: Project, id: string): Promise<void>;
}
```

`registerUpload` hashes the staged source, writes the initial job, and leaves processing detached to the caller. `process` inspects the PDF, writes raw pages to a task-local directory, creates normalized assets, builds every `SceneSchema` and `PresentationManifestSchema`, then calls `mutateStoryboard` once. Move the completed asset directory before saving; if save fails, keep it unreferenced and mark the job failed. Never append incrementally.

Use server-generated scene IDs `scene-${randomUUID().slice(0, 8)}` with collision checks against the latest storyboard. Set the physical clip duration to `1`, source kind to `presentation`, and `hold_duration_sec` to `5`. After a successful save, update the final manifest and job to `ready` or `drafting-narration`.

`remove` must use `mutateStoryboard` to remove all remaining scenes whose `presentation_source.presentation_id` matches, save that change first, then remove presentation assets. A failed asset deletion emits a bounded private warning but does not restore scenes.

- [ ] **Step 9: Run the persistence and import tests**

Run: `npm run build -w @vpa/shared && npm test -w @vpa/server -- src/services/project/paths.test.ts src/services/storyboard/index.test.ts src/routes/storyboard.test.ts src/routes/scripts.test.ts src/services/presentation/job-store.test.ts src/services/presentation/import-service.test.ts`

Expected: PASS.

- [ ] **Step 10: Commit atomic import**

```bash
git add apps/server/src/config.ts apps/server/src/services/project apps/server/src/services/storyboard apps/server/src/routes/storyboard.ts apps/server/src/routes/storyboard.test.ts apps/server/src/routes/scripts.ts apps/server/src/routes/scripts.test.ts apps/server/src/services/presentation/job-store.ts apps/server/src/services/presentation/job-store.test.ts apps/server/src/services/presentation/import-service.ts apps/server/src/services/presentation/import-service.test.ts
git commit -m "feat(presentations): import slide scenes atomically"
```

---

### Task 4: Narration-aware duration in both render paths

**Files:**
- Create: `apps/server/src/services/render/scene-duration.ts`
- Create: `apps/server/src/services/render/scene-duration.test.ts`
- Modify: `apps/server/src/services/render/index.ts`
- Modify: `apps/server/src/services/render/scene-render.ts`
- Modify: `apps/server/src/services/render/scene-render.test.ts`
- Modify: `apps/server/src/services/quality-review/index.ts`
- Modify: `apps/server/src/services/quality-review/index.test.ts`
- Modify: `apps/web/src/components/RecordingInfo.tsx`
- Modify: `apps/web/src/pages/ScenePage.tsx`

**Interfaces:**
- Produces: `resolveSceneDuration(scene, narrationAudioDuration?): SceneDurationResolution`.
- Produces: exact FFmpeg target duration for generated presentation clips.
- Consumes: Task 1 `presentation_source.hold_duration_sec`.

- [ ] **Step 1: Write failing duration-helper tests**

Use this contract:

```ts
expect(resolveSceneDuration(slideScene, 12.4)).toEqual({
  targetSec: 12.4,
  flexible: true,
  source: 'narration',
});
expect(resolveSceneDuration(slideScene)).toEqual({
  targetSec: 5,
  flexible: true,
  source: 'slide-hold',
});
expect(resolveSceneDuration(videoScene)).toEqual({
  targetSec: 30,
  flexible: false,
  source: 'recording',
});
```

- [ ] **Step 2: Implement the duration helper**

Export:

```ts
export interface SceneDurationResolution {
  targetSec: number;
  flexible: boolean;
  source: 'narration' | 'slide-hold' | 'recording';
}
```

Presentation scenes use a positive finite narration duration when provided, otherwise their validated hold duration. Other scenes use `recording.duration_sec` and throw a bounded render error if it is absent.

- [ ] **Step 3: Write failing full-project and single-scene render tests**

For a one-second presentation clip, assert an 8.25-second narration produces a video chain containing `tpad=stop_mode=clone` followed by `trim=duration=8.250`. Without narration, assert `trim=duration=5.000`. Assert a normal recording keeps its existing duration behavior.

- [ ] **Step 4: Apply exact duration in both render paths**

In project `muxScene` and single-scene `muxOne`, probe narration once, resolve the target, and for flexible presentation scenes always add:

```ts
const padSec = Math.max(0, targetSec - videoDuration);
if (padSec > 0.05) filters.push(`tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}`);
filters.push(`trim=duration=${targetSec.toFixed(3)},setpts=PTS-STARTPTS`);
```

Map the filtered video and remove `-shortest` for presentation replacement audio. Preserve existing behavior for non-presentation scenes.

- [ ] **Step 5: Update quality review and duration UI**

Do not emit `narration_too_long` for flexible presentation scenes because the visual stretches to narration. Display **Narration sets final length** when a presentation scene has audio and **5s hold without narration** when it does not. Never display the physical one-second clip as the meaningful slide duration.

- [ ] **Step 6: Run render and quality tests**

Run: `npm test -w @vpa/server -- src/services/render/scene-duration.test.ts src/services/render/scene-render.test.ts src/services/quality-review/index.test.ts && npm run typecheck -w @vpa/web`

Expected: PASS.

- [ ] **Step 7: Commit duration handling**

```bash
git add apps/server/src/services/render apps/server/src/services/quality-review apps/web/src/components/RecordingInfo.tsx apps/web/src/pages/ScenePage.tsx
git commit -m "feat(presentations): size slide scenes to narration"
```

---

### Task 5: Presentation HTTP API and restart reconciliation

**Files:**
- Create: `apps/server/src/routes/presentations.ts`
- Create: `apps/server/src/routes/presentations.test.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/server.test.ts`

**Interfaces:**
- Produces: the presentation endpoints from the approved design plus a safe page-image endpoint.
- Consumes: Task 3 `PresentationImportService` and configured upload limits.

- [ ] **Step 1: Write failing route tests with an injected service**

Cover exact responses:

```ts
expect(upload.statusCode).toBe(202);
expect(upload.json()).toMatchObject({
  presentation_id: expect.any(String),
  job: { stage: 'processing-slides', status: 'processing' },
});
```

Test one PDF file only, PDF content signature validation delegated to the service, `generate_narration=false`, 100 MB route limit mapping to `file_too_large`, missing projects, list/get, retry-import, retry-narration returning `501` until Task 7 supplies the callback, confirmed delete, and page-image serving with `image/png`, `nosniff`, and no arbitrary path query.

- [ ] **Step 2: Implement multipart streaming and route registration**

Export:

```ts
export interface PresentationRouteDeps {
  store: ProjectStore;
  service: PresentationImportService;
  maxBytes: number;
  retryNarration?: (project: Project, presentationId: string) => Promise<PresentationJob>;
}

export async function registerPresentationRoutes(
  app: FastifyInstance,
  deps: PresentationRouteDeps,
): Promise<void>;
```

Implement:

- `POST /api/projects/:id/presentations`
- `GET /api/projects/:id/presentations`
- `GET /api/projects/:id/presentations/:presentationId`
- `POST /api/projects/:id/presentations/:presentationId/retry-import`
- `POST /api/projects/:id/presentations/:presentationId/retry-narration`
- `DELETE /api/projects/:id/presentations/:presentationId?confirmed=true`
- `GET /api/projects/:id/presentations/:presentationId/pages/:pageNumber/image`

Return `{ presentation_id, job }` from upload, `{ presentations: jobs }` from
list, one validated job from get/retry endpoints, and HTTP `204` from confirmed
delete. The image endpoint resolves the requested page only through the
validated manifest page record.

Generate the UUID before staging, create `.presentation-staging/<id>/source.pdf` with mode `0o600`, and stream with `stageUploadStream`. Read all multipart parts before registering the upload so the boolean field may appear before or after the file. Accept only one non-empty file. Start `service.process(project, id)` detached after returning the registered job, and log only job/project IDs plus a bounded error class.

- [ ] **Step 3: Add startup reconciliation**

Add `PresentationImportService.reconcile(projects)` and test that it:

- Marks jobs left in `uploading`, `processing-slides`, or `creating-scenes` as failed with `interrupted_import`.
- Leaves committed manifests and scenes intact.
- Restarts only `drafting-narration` jobs through the optional AI callback.
- Removes staging directories with no matching job.
- Removes a final presentation directory only when no manifest scene ID appears in the current storyboard and its matching job never reached ready.

Call reconciliation in `buildServer()` after model/service construction and before returning the app. A reconciliation failure logs and does not prevent server startup.

- [ ] **Step 4: Wire server construction and test seams**

Add optional `presentationService` and `retryPresentationNarration` to `BuildServerOptions`. Construct the real job store and import service when not injected, register the routes, and use `config.presentation.maxBytes`. Extend `server.test.ts` to assert the route exists with injected fakes and no filesystem/network work.

- [ ] **Step 5: Run route and server tests**

Run: `npm test -w @vpa/server -- src/routes/presentations.test.ts src/server.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the API**

```bash
git add apps/server/src/routes/presentations.ts apps/server/src/routes/presentations.test.ts apps/server/src/server.ts apps/server/src/server.test.ts
git commit -m "feat(presentations): expose import and management API"
```

---

### Task 6: Gemini slide understanding and cached briefs

**Files:**
- Create: `apps/server/src/services/presentation/gemini-image.ts`
- Create: `apps/server/src/services/presentation/gemini-image.test.ts`
- Create: `apps/server/src/services/presentation/slide-understanding.ts`
- Create: `apps/server/src/services/presentation/slide-understanding.test.ts`
- Create: `apps/server/prompts/presentation-slide-understanding.md`

**Interfaces:**
- Produces: `GeminiImageTransport.generateWithImage(input): Promise<string>`.
- Produces: `SlideUnderstandingService.ensureBrief(input, model): Promise<PresentationSlideBrief>`.
- Consumes: Task 1 `ResolvedVisualModel` and `PresentationSlideBriefSchema`.

- [ ] **Step 1: Write failing inline-image transport tests**

Inject `fetch` and `readFile`. Assert the request uses Gemini `generateContent`, API key only in the request URL, and this part ordering:

```ts
expect(body.contents[0].parts).toEqual([
  { inline_data: { mime_type: 'image/png', data: imageBytes.toString('base64') } },
  { text: 'Analyze slide 1.' },
]);
expect(body.generationConfig.responseMimeType).toBe('application/json');
```

Assert non-2xx responses and missing candidate text become generic transport errors without response bodies.

- [ ] **Step 2: Implement the Gemini image transport**

Use:

```ts
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
```

Read the bounded local image, encode it once, send with a 60-second timeout, and return only candidate text. Do not use Gemini Files API because slide PNGs fit the bounded inline-image path and need no remote cleanup lifecycle.

- [ ] **Step 3: Write failing slide-brief service tests**

Test valid generation, fenced JSON parsing, schema rejection, image/text hash freshness, model and prompt invalidation, in-flight deduplication, safe scene/page IDs, and private diagnostics. Assert a fresh brief causes zero transport calls.

- [ ] **Step 4: Add the visual-analysis prompt**

The prompt must require JSON with exactly these keys: `visual_summary`, `detected_title`, `key_points`, `visual_elements`, `quantitative_claims`, and `uncertain_content`. It must instruct Gemini to preserve numbers and units, distinguish visible facts from inference, put unreadable material in `uncertain_content`, and never invent speaker notes.

- [ ] **Step 5: Implement `SlideUnderstandingService`**

Use this input:

```ts
export interface EnsureSlideBriefInput {
  projectPath: string;
  presentationId: string;
  pageNumber: number;
  imagePath: string;
  extractedText: string;
}
```

Hash a snapshot of the page image plus the extracted text. Store a validated artifact at `presentations/<id>/analysis/page-NNNN.json`. Freshness must compare image hash, text hash, visual model entry/concrete model IDs, schema version, and prompt version. Bound each list at 50 items and each item at 1,000 characters. Concurrent calls for the same full freshness key share one promise.

- [ ] **Step 6: Run Gemini and slide-brief tests**

Run: `npm test -w @vpa/server -- src/services/presentation/gemini-image.test.ts src/services/presentation/slide-understanding.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit visual understanding**

```bash
git add apps/server/src/services/presentation/gemini-image.ts apps/server/src/services/presentation/gemini-image.test.ts apps/server/src/services/presentation/slide-understanding.ts apps/server/src/services/presentation/slide-understanding.test.ts apps/server/prompts/presentation-slide-understanding.md
git commit -m "feat(presentations): understand slides with Gemini"
```

---

### Task 7: Writing-model narration drafts, preservation, and retry

**Files:**
- Create: `apps/server/src/services/presentation/narration-drafter.ts`
- Create: `apps/server/src/services/presentation/narration-drafter.test.ts`
- Create: `apps/server/prompts/presentation-narration-writer.md`
- Modify: `apps/server/src/routes/presentations.ts`
- Modify: `apps/server/src/routes/presentations.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Produces: `PresentationNarrationDrafter.run(project, presentationId): Promise<PresentationJob>`.
- Produces: `.retry(project, presentationId)` for missing/failed/unapplied pages.
- Consumes: Task 6 slide briefs, `ModelRouter.resolveVisual`, and `ModelRouter.resolveText('writing')`.

- [ ] **Step 1: Write failing narration-drafter tests**

Cover this two-pass order:

```ts
expect(callOrder).toEqual([
  'analyze:1', 'analyze:2', 'analyze:3',
  'write:1', 'write:2', 'write:3',
]);
```

Assert the writer input contains objective, audience, current slide title/text/brief, previous and next slide titles/summaries, and no image bytes or URI. Assert generated narration is stored as:

```ts
{
  script,
  monologueScript: script,
  dialogDirty: true,
}
```

Test missing visual assignment, missing writing assignment, one failed page with other pages preserved, brief reuse, retrying only failed/missing scripts, and exact user-edit preservation for name, description, and narration script. When a field changed from its manifest baseline, assert the draft file remains and the page status becomes `preserved-user-edit`.

- [ ] **Step 2: Add the narration-writing prompt**

Require plain spoken prose with no markdown, no bullet-by-bullet reading, no invented claims, and no mention of “this slide.” Ask for a concise bridge from the previous slide and toward the next only when context supports it. Treat `uncertain_content` as prohibited facts. Set an upper bound of 12,000 returned characters and trim whitespace.

- [ ] **Step 3: Implement two-pass drafting with bounded concurrency**

Export:

```ts
export class PresentationNarrationDrafter {
  run(project: Project, presentationId: string): Promise<PresentationJob>;
  retry(project: Project, presentationId: string): Promise<PresentationJob>;
}
```

Resolve both models before starting page work. Analyze pages with concurrency `2`, persist each successful brief/status, then write pages with concurrency `2`. Store every validated `PresentationDraft` under `drafts/page-NNNN.json` before attempting to apply it.

Apply with `mutateStoryboard`. Compare the latest scene's name, description, and script to the manifest baseline independently. Set the Gemini detected title only when the baseline fallback was `Slide N`; set visual summary as description only when description remains at baseline; set narration only when the script remains absent. Never clear existing TTS fields because an absent baseline has no TTS. Record the visual and writer entry/model IDs in the manifest.

The final job is `ready` when all requested scripts applied, `partial` when at least one page failed or preserved a user edit, and `failed` only when no page could begin because routing is missing/incompatible/unavailable. Public job messages use stable codes and contain no provider response.

- [ ] **Step 4: Wire automatic start and retry route**

After deterministic commit, call `drafter.run` detached only when `generate_narration` is true. Replace the Task 5 `501` branch with `drafter.retry`. Server restart reconciliation may resume `drafting-narration` by calling `retry`; it must not rerun deterministic import.

- [ ] **Step 5: Run drafter and route tests**

Run: `npm test -w @vpa/server -- src/services/presentation/narration-drafter.test.ts src/routes/presentations.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit narration drafting**

```bash
git add apps/server/src/services/presentation/narration-drafter.ts apps/server/src/services/presentation/narration-drafter.test.ts apps/server/prompts/presentation-narration-writer.md apps/server/src/routes/presentations.ts apps/server/src/routes/presentations.test.ts apps/server/src/server.ts
git commit -m "feat(presentations): draft narration with routed models"
```

---

### Task 8: Typed web API and local PDF preview

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/presentation-preview.ts`
- Create: `apps/web/src/lib/presentation-preview.test.ts`
- Create: `apps/web/src/lib/presentation-import-ui.ts`
- Create: `apps/web/src/lib/presentation-import-ui.test.ts`

**Interfaces:**
- Produces: `presentationsApi` upload/list/get/retry/delete/image methods.
- Produces: `previewPresentation(file): Promise<PresentationPreview>`.
- Produces: pure progress and action view models for React components.

- [ ] **Step 1: Add browser PDF.js**

Run: `npm install -w @vpa/web pdfjs-dist`

Expected: the web workspace directly declares `pdfjs-dist`.

- [ ] **Step 2: Write failing preview and view-model tests**

Inject a PDF loader and canvas factory. Assert only the first four pages render as data URLs, page count includes all pages, encrypted/invalid inputs produce `PresentationPreviewError`, and a new preview closes the prior PDF task.

For progress mapping, assert:

```ts
expect(presentationProgress(job)).toEqual({
  label: 'Drafting narration',
  detail: '2 of 5 scripts ready',
  terminal: false,
  tone: 'working',
});
expect(presentationActions(failedImport)).toEqual(['retry-import', 'remove']);
expect(presentationActions(partialNarration)).toEqual(['retry-narration', 'remove']);
```

- [ ] **Step 3: Implement typed API methods**

Parse all responses with Task 1 schemas. Add:

```ts
export const presentationsApi = {
  upload(projectId: string, file: File, generateNarration: boolean): Promise<PresentationJob>,
  list(projectId: string): Promise<PresentationJob[]>,
  get(projectId: string, presentationId: string): Promise<PresentationJob>,
  retryImport(projectId: string, presentationId: string): Promise<PresentationJob>,
  retryNarration(projectId: string, presentationId: string): Promise<PresentationJob>,
  remove(projectId: string, presentationId: string): Promise<void>,
  imageUrl(projectId: string, presentationId: string, pageNumber: number): string,
};
```

`upload` sends `file` and string field `generate_narration` in `FormData`, uses a five-minute timeout, and reports the server's bounded `ApiError` message.
It parses the upload wrapper and returns `response.job`; `list` parses
`response.presentations`. The remaining methods parse the direct job response.

- [ ] **Step 4: Implement browser-local preview**

Configure `GlobalWorkerOptions.workerSrc` with Vite's `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()`. Reject files whose name does not end in `.pdf` or whose size exceeds 100 MB before loading. Render at most four thumbnails to canvases no wider than 320 CSS pixels and return:

```ts
export interface PresentationPreview {
  pageCount: number;
  thumbnails: Array<{ pageNumber: number; dataUrl: string }>;
}
```

Treat this as preview only; never use it to decide server limits or page ordering after upload.

- [ ] **Step 5: Implement pure progress/action mapping**

Map every Task 1 stage/status to bounded copy. `drafting-narration` detail uses `scripted_pages` and `page_count`; deterministic processing uses `processed_pages`; `partial` explains that slides are ready and narration needs attention. `remove` is always available for committed or failed imports; retry actions appear only for their matching failure stage.

- [ ] **Step 6: Run web library tests**

Run: `npm run build -w @vpa/shared && npm test -w @vpa/web -- src/lib/presentation-preview.test.ts src/lib/presentation-import-ui.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit web foundations**

```bash
git add apps/web/package.json package-lock.json apps/web/src/lib/api.ts apps/web/src/lib/presentation-preview.ts apps/web/src/lib/presentation-preview.test.ts apps/web/src/lib/presentation-import-ui.ts apps/web/src/lib/presentation-import-ui.test.ts
git commit -m "feat(presentations): add preview and web API clients"
```

---

### Task 9: New-project and storyboard import experience

**Files:**
- Create: `apps/web/src/components/PresentationFilePicker.tsx`
- Create: `apps/web/src/components/PresentationImportDialog.tsx`
- Create: `apps/web/src/components/PresentationProgress.tsx`
- Modify: `apps/web/src/components/NewProjectDialog.tsx`
- Modify: `apps/web/src/pages/Dashboard.tsx`
- Modify: `apps/web/src/pages/StoryboardView.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: reusable file picker, progress display, and existing-project import dialog.
- Consumes: Task 8 preview utilities and `presentationsApi`.

- [ ] **Step 1: Build the reusable file picker**

Use these props:

```ts
export interface PresentationFilePickerProps {
  file: File | null;
  disabled?: boolean;
  onChange(file: File | null): void;
}
```

Accept `.pdf` only. Show file name, rounded KB/MB size, page count, up to four thumbnails, and `+N more slides`. Show preview errors inline without clearing the selected file so the user can replace it. Revoke/clear prior preview state when the file changes or the component unmounts.

- [ ] **Step 2: Add Presentation as a new-project mode**

Extend `NewProjectMode` to `'ideate' | 'recordings' | 'presentation'`. Add exact copy:

- Heading: **Create a narrated presentation**
- Lead: **Upload a PDF deck. VPA creates one scene per slide and can draft narration for each one.**
- Button: **Create & import presentation**

In presentation mode, show `PresentationFilePicker` and a checked **Generate draft narration** checkbox; hide the reference-doc picker. Include the selected file in the unsaved-change guard. Disable create until project name and a valid preview are present. Extend the callback to
`onCreated(id: string, result?: { presentationId: string }): void` so the
dialog preserves the existing parent-owned navigation pattern.

After project creation, store the returned project ID before calling
`presentationsApi.upload`. If upload fails, **Try upload again** must reuse that
stored project ID and must not call `api.createProject` again; **Open empty
project** calls `onCreated(projectId)`. On accepted upload, call
`onCreated(projectId, { presentationId: job.id })` while server processing
continues.

- [ ] **Step 3: Add the dashboard entry point**

Add a third hero card with `Presentation` icon, title **I have a presentation**, description **Upload a PDF; we'll create one narratable scene per slide.**, and a `new-presentation` modal state. Its completion handler navigates to
`/project/:id/storyboard?presentation=<presentation-id>` when the result is
present and to `/project/:id/storyboard` otherwise. Keep the grid responsive at
three columns on wide screens and one column on narrow screens.

- [ ] **Step 4: Build existing-project import and progress components**

`PresentationImportDialog` contains the same picker and narration checkbox. It starts upload, closes after `202`, and calls `onAccepted(job)`.

`PresentationProgress` accepts one `PresentationJob`, polls its detail every second while nonterminal, and renders the Task 8 progress model. Closing the progress surface stops only polling; it does not cancel server work. On ready/partial transition, invalidate `['storyboard', projectId]` and `['presentations', projectId]` exactly once.

- [ ] **Step 5: Integrate Storyboard controls and empty state**

Add **Add presentation** below the storyboard scene count and inside `EmptyStoryboard`. If `?presentation=` is present, select that job's progress card until it becomes terminal, then remove only the query parameter and preserve `?scene` and `?tab`. When the first imported scene appears and no scene is selected, select it using the existing URL normalization.

- [ ] **Step 6: Add focused styling and accessibility**

Use existing CSS variables and dialog conventions. Thumbnails must use `object-fit: contain`, buttons need visible focus state, progress changes use `aria-live="polite"`, file errors use `role="alert"`, and each thumbnail alt text is `Slide preview N`.

- [ ] **Step 7: Typecheck and build the web app**

Run: `npm run typecheck -w @vpa/web && npm run build -w @vpa/web`

Expected: PASS with no TypeScript or Vite errors.

- [ ] **Step 8: Commit the import UX**

```bash
git add apps/web/src/components/PresentationFilePicker.tsx apps/web/src/components/PresentationImportDialog.tsx apps/web/src/components/PresentationProgress.tsx apps/web/src/components/NewProjectDialog.tsx apps/web/src/pages/Dashboard.tsx apps/web/src/pages/StoryboardView.tsx apps/web/src/styles.css
git commit -m "feat(presentations): add deck upload experience"
```

---

### Task 10: Deck management, end-to-end coverage, and final verification

**Files:**
- Create: `apps/web/src/components/PresentationImports.tsx`
- Modify: `apps/web/src/pages/StoryboardView.tsx`
- Create: `tests/e2e/presentation-import.spec.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-05-presentation-import-design.md` only if implementation names differ after verified code review

**Interfaces:**
- Produces: project-level retry/remove controls and final acceptance coverage.
- Consumes: all prior task APIs and UI components.

- [ ] **Step 1: Implement presentation management controls**

List imports under a collapsible **Presentations** section in the storyboard rail. Each item shows display name, page count, progress/status, import timestamp, and these exact actions from Task 8:

- **Retry import** for recoverable deterministic failures.
- **Retry narration** for partial/failed AI work.
- **Remove imported deck** for every retained job/import.

Removal opens a confirmation stating the exact number of remaining scenes that will be deleted. Confirm by calling `presentationsApi.remove`, then invalidate storyboard and presentation queries and select the next remaining scene. An asset-cleanup warning does not restore deleted scenes.

- [ ] **Step 2: Add an E2E PDF fixture generator**

Inside `presentation-import.spec.ts`, use `pdf-lib` to produce a three-page in-memory PDF with headings `Opening`, `Architecture`, and `Next steps`. Upload through the UI with draft narration unchecked so the test is deterministic and makes no model calls.

- [ ] **Step 3: Write the end-to-end happy path**

Assert:

1. The dashboard has **I have a presentation**.
2. Local preview reports three slides before project creation.
3. The progress UI advances without requiring the dialog to remain open.
4. The storyboard contains three `slide` scenes in PDF order.
5. Reordering a slide works through the existing controls.
6. Reloading preserves scenes and presentation status.
7. The scene duration UI says **5s hold without narration** rather than `1s`.

- [ ] **Step 4: Write E2E retry and removal coverage**

Use route interception for a bounded failed-job response and assert **Retry import** and the public error appear. For a successful import, remove one individual scene and assert the presentation remains listed; then choose **Remove imported deck**, confirm the remaining-scene count, and assert all scenes from that presentation disappear.

- [ ] **Step 5: Document the supported workflow**

Add a README section stating: PDF only, one scene per page, 100 MB/200-page defaults, static handling of animations/embedded media, Gemini visual assignment, independent writing assignment, narration-driven duration, and the future PPTX/Google-export path. Include the environment variable names `VPA_PRESENTATION_MAX_BYTES` and `VPA_PRESENTATION_MAX_PAGES`.

- [ ] **Step 6: Run targeted presentation tests**

Run:

```bash
npm run build -w @vpa/shared
npm test -w @vpa/shared -- presentation storyboard model-routing
npm test -w @vpa/server -- src/services/presentation src/routes/presentations.test.ts src/services/render/scene-duration.test.ts src/services/render/scene-render.test.ts src/services/quality-review/index.test.ts
npm test -w @vpa/web -- src/lib/presentation-preview.test.ts src/lib/presentation-import-ui.test.ts src/lib/model-routing.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the presentation E2E test**

Run: `npm run e2e -- tests/e2e/presentation-import.spec.ts`

Expected: PASS.

- [ ] **Step 8: Run full verification**

Run:

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

Expected: every command exits 0; the test report has no unexpected skips or failures.

- [ ] **Step 9: Perform the real-deck acceptance test**

Import one local PDF containing a 16:9 page, 4:3 page, portrait page, chart, screenshot, and image-only page. Confirm no page crops, generate narration with the configured Gemini visual model plus writing model, synthesize voiceover, render the complete project, and verify final scene durations match narration audio. Record the deck name, model names, page count, and final output path in the PR description; do not commit the private deck or rendered video.

- [ ] **Step 10: Commit management, tests, and docs**

```bash
git add apps/web/src/components/PresentationImports.tsx apps/web/src/pages/StoryboardView.tsx tests/e2e/presentation-import.spec.ts README.md docs/superpowers/specs/2026-08-05-presentation-import-design.md
git commit -m "test(presentations): verify narrated deck workflow"
```

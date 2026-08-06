# Project-wide Narration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one project-level narration action that applies a selected TTS engine and voice to every scripted scene while skipping empty scripts and preserving current audio unless overwrite is explicitly enabled.

**Architecture:** A focused server orchestrator snapshots storyboard order, reloads each scene immediately before work, and delegates sequential chunk generation to the existing `generateAllChunks` service. A strict project endpoint owns one job per project and reports bounded progress through the existing job queue; a new Narration-page panel selects the engine/voice and follows or recovers that job.

**Tech Stack:** TypeScript, Fastify, Zod, React, TanStack Query, Vitest, Testing Library, Playwright, existing VPA TTS and job-stream services.

## Global Constraints

- Never generate, repair, or infer a script; trim and skip an empty active script before model or TTS resolution.
- Preserve existing narration unless `overwrite: true` is explicitly submitted.
- Preserve explicit dialog speaker engine, voice, and speed assignments.
- Process scenes sequentially in storyboard order.
- Continue after bounded per-scene failures; retain successfully written audio on failure or cancellation.
- Permit only one active `narration-generate-project` job per project.
- Reject unknown request fields and unknown engine/voice combinations before job creation.
- Do not expose provider diagnostics, API keys, filesystem paths, or raw exception text.
- Keep all existing scene-level narration routes and controls compatible.

---

### Task 1: Project narration eligibility and sequential orchestrator

**Files:**
- Modify: `apps/server/src/services/narration/index.ts`
- Create: `apps/server/src/services/narration/project-generation.ts`
- Create: `apps/server/src/services/narration/project-generation.test.ts`

**Interfaces:**
- Consumes: existing `generateAllChunks(input, tts, llm, workspaceRoot, onProgress, isCancelled)` and `loadStoryboard(projectPath)`.
- Produces: `inspectNarrationBatch(scene, selection)`, `generateProjectNarration(input, dependencies)`, `ProjectNarrationProgress`, and `ProjectNarrationResult` for Task 2.

- [ ] **Step 1: Export a read-only batch inspection result and write its failing tests**

Add tests beside existing narration service tests proving the inspection uses the exact same private plan as generation:

```ts
expect(inspectNarrationBatch(scriptedScene, {
  engine: 'xai', voice: 'Ara', selector: 'missing',
})).toEqual({ targetCount: 1, requiresWriting: true });

expect(inspectNarrationBatch(completeScene, {
  engine: 'gemini', voice: 'Kore', selector: 'missing',
})).toEqual({ targetCount: 0, requiresWriting: false });
```

Include a dialog fixture whose explicit xAI speaker override makes
`requiresWriting` true even when the project engine is Gemini.

- [ ] **Step 2: Run the focused inspection tests and confirm RED**

Run:

```bash
npm test -w @vpa/server -- src/services/narration/index.test.ts
```

Expected: FAIL because `inspectNarrationBatch` is not exported.

- [ ] **Step 3: Implement `inspectNarrationBatch` without duplicating target logic**

Add:

```ts
export interface NarrationBatchInspection {
  targetCount: number;
  requiresWriting: boolean;
}

export function inspectNarrationBatch(
  scene: Scene,
  input: BatchVoiceSelection,
): NarrationBatchInspection {
  const plan = planBatchNarration(scene, input);
  return {
    targetCount: plan.targets.length,
    requiresWriting: plan.targets.some((target) => target.engine === 'xai'),
  };
}
```

Change `batchRequiresWriting` to delegate to this function so routing and
generation cannot diverge.

- [ ] **Step 4: Write failing orchestrator tests**

Create fixtures with three ordered scenes: scripted and missing audio,
unscripted, and scripted with complete audio. Test:

```ts
const result = await generateProjectNarration(
  {
    projectPath,
    scenes: [
      { id: 'scene-01', name: 'One' },
      { id: 'scene-02', name: 'Two' },
      { id: 'scene-03', name: 'Three' },
    ],
    engine: 'gemini',
    voice: 'Kore',
    speed: 1,
    expressiveness: 'medium',
    overwrite: false,
  },
  dependencies,
);

expect(generateScene).toHaveBeenCalledTimes(1);
expect(generateScene).toHaveBeenCalledWith(expect.objectContaining({
  sceneId: 'scene-01', selector: 'missing',
}));
expect(result).toMatchObject({
  totalScenes: 3,
  generatedScenes: 1,
  preservedScenes: 1,
  noScriptScenes: 1,
  failedScenes: 0,
});
```

Add separate cases for overwrite using selector `all`, explicit dialog speaker
resolution, script removal between scenes, scene removal, cancellation,
per-scene failure continuation, capped safe failures, and zero model/TTS calls
when no work is eligible.

- [ ] **Step 5: Run the orchestrator tests and confirm RED**

Run:

```bash
npm test -w @vpa/server -- src/services/narration/project-generation.test.ts
```

Expected: FAIL because `project-generation.ts` does not exist.

- [ ] **Step 6: Implement the orchestrator**

Define:

```ts
export interface ProjectNarrationInput {
  projectPath: string;
  scenes: Array<{ id: string; name: string }>;
  engine: string;
  voice: string;
  speed: number;
  expressiveness: Expressiveness;
  overwrite: boolean;
}

export interface ProjectNarrationFailure {
  sceneId: string;
  sceneName: string;
  code: 'scene_generation_failed';
}

export interface ProjectNarrationResult {
  totalScenes: number;
  generatedScenes: number;
  generatedChunks: number;
  preservedScenes: number;
  noScriptScenes: number;
  removedScenes: number;
  failedScenes: number;
  cancelled: boolean;
  failures: ProjectNarrationFailure[];
}

export interface ProjectNarrationDependencies {
  loadStoryboard: typeof loadStoryboard;
  inspectBatch: typeof inspectNarrationBatch;
  resolveWriter: (scene: Scene, selection: BatchVoiceSelection) => Promise<LlmClient | undefined>;
  generateScene: (
    input: BatchInput,
    writer: LlmClient | undefined,
    onProgress: (progress: BatchProgress) => void,
    isCancelled: () => boolean,
  ) => Promise<{ total: number; completed: number; failed: number }>;
  onProgress: (progress: ProjectNarrationProgress) => void;
  isCancelled: () => boolean;
}
```

Reload the storyboard before every scene. Trim
`scene.narration?.script ?? ''`; skip when empty. Inspect with selector `all`
when overwriting and `missing` otherwise. Treat zero targets as preserved.
Resolve a writer only when inspection says it is required. Emit one bounded
project progress object at each scene boundary and map any thrown scene error
to `scene_generation_failed` without retaining its message. Cap `failures` at
20 entries while keeping the full numeric count.

- [ ] **Step 7: Run focused narration service tests and confirm GREEN**

Run:

```bash
npm test -w @vpa/server -- src/services/narration/index.test.ts src/services/narration/project-generation.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add apps/server/src/services/narration/index.ts apps/server/src/services/narration/project-generation.ts apps/server/src/services/narration/project-generation.test.ts
git commit -m "feat(narration): orchestrate project audio generation"
```

---

### Task 2: Strict project narration route and job ownership

**Files:**
- Modify: `apps/server/src/routes/narration.ts`
- Modify: `apps/server/src/routes/narration.test.ts`

**Interfaces:**
- Consumes: Task 1 `generateProjectNarration`, `inspectNarrationBatch`, and result/progress types; existing `jobQueue`, `TtsService`, and `ModelRouter`.
- Produces: `POST /api/projects/:id/narration/generate-project` returning `{ jobId, status: 'running' }` and emitting project progress/result events.

- [ ] **Step 1: Write failing route validation and ownership tests**

Add route tests proving:

```ts
await expectResponse(
  app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/narration/generate-project`,
    payload: {
      engine: 'fake', voice: 'alice', speed: 1,
      expressiveness: 'medium', overwrite: false,
    },
  }),
  200,
);
```

Also assert 400 for primitives, `null`, extra properties, speed below 0.5 or
above 2, invalid expressiveness, non-boolean overwrite, unknown engine, and a
voice not advertised by the chosen engine. Assert 409 for a second active
project job but allow a concurrent job for a different project.

- [ ] **Step 2: Run route tests and confirm RED**

Run:

```bash
npm test -w @vpa/server -- src/routes/narration.test.ts
```

Expected: FAIL with route not found.

- [ ] **Step 3: Add strict schema and preflight validation**

Use:

```ts
const ProjectNarrationRequestSchema = z.object({
  engine: z.string().min(1).max(100),
  voice: z.string().min(1).max(200),
  speed: z.number().finite().min(0.5).max(2).default(1),
  expressiveness: z.enum(['light', 'medium', 'heavy']).default('medium'),
  overwrite: z.boolean().default(false),
}).strict();
```

Resolve the engine with `tts.listEngines()` and require an exact voice ID from
that engine before creating a job. Reject another active job when:

```ts
jobQueue.list({ activeOnly: true, projectId: id })
  .some((candidate) => candidate.type === 'narration-generate-project')
```

- [ ] **Step 4: Start and complete the project job**

Snapshot `storyboard.scenes.map(({ id, name }) => ({ id, name }))`, create the
job with type `narration-generate-project`, and run the orchestrator in the
background. Pass `jobQueue.emit(job.id, 'progress', progress)` for project
events and use `jobQueue.get(job.id)?.status === 'cancelled'` for cancellation.

Use a cached lazy writer resolution:

```ts
let writerPromise: ReturnType<ModelRouter['resolveText']> | undefined;
const resolveWriter = async () => {
  writerPromise ??= router.resolveText('writing', project);
  return (await writerPromise).client;
};
```

Complete the job with the bounded result. Only failures before orchestration
starts call `jobQueue.fail`; per-scene failures are represented in the
completed result.

- [ ] **Step 5: Add behavior tests for no-script, overwrite, dialog overrides, progress, failure continuation, and cancellation**

Use deterministic fake TTS providers and injected/stubbed writer resolution.
Assert that no-script and preserved scenes produce no provider calls, overwrite
changes the selector, scene events remain in storyboard order, and public job
events never contain injected private paths or provider exception strings.

- [ ] **Step 6: Run focused route and service tests and confirm GREEN**

Run:

```bash
npm test -w @vpa/server -- src/routes/narration.test.ts src/services/narration/project-generation.test.ts src/services/narration/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/server/src/routes/narration.ts apps/server/src/routes/narration.test.ts
git commit -m "feat(narration): expose project generation job"
```

---

### Task 3: Project narration controls, progress, and recovery

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/project-narration.ts`
- Create: `apps/web/src/lib/project-narration.test.ts`
- Create: `apps/web/src/components/ProjectNarrationPanel.tsx`
- Create: `apps/web/src/components/ProjectNarrationPanel.test.tsx`
- Modify: `apps/web/src/pages/NarrationPage.tsx`
- Create: `apps/web/src/pages/NarrationPage.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 2 endpoint, existing `ttsApi.listEngines`, `jobsApi`, narration cancellation, storyboard query, and `Job`/`Scene` shared types.
- Produces: typed `narrationApi.generateProject`, `ProjectNarrationPanel`, and pure eligibility/status helpers.

- [ ] **Step 1: Write failing pure eligibility tests**

Define expected client preview behavior:

```ts
expect(projectNarrationPreview(scenes, false)).toEqual({
  scriptedScenes: 3,
  willNarrateScenes: 2,
  preservedScenes: 1,
  noScriptScenes: 2,
});

expect(projectNarrationPreview(scenes, true)).toEqual({
  scriptedScenes: 3,
  willNarrateScenes: 3,
  preservedScenes: 0,
  noScriptScenes: 2,
});
```

Treat an empty or whitespace-only active script as no script. Treat a scene as
currently narrated when it has a legacy narration audio path or any audio chunk;
the server remains authoritative for stale/partial chunks.

- [ ] **Step 2: Run helper tests and confirm RED**

Run:

```bash
npm test -w @vpa/web -- src/lib/project-narration.test.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Add typed API and pure helpers**

Add:

```ts
export interface GenerateProjectNarrationOptions {
  engine: string;
  voice: string;
  speed: number;
  expressiveness: Expressiveness;
  overwrite: boolean;
}

async generateProject(
  projectId: string,
  options: GenerateProjectNarrationOptions,
): Promise<{ jobId: string; status: 'running' }> {
  return request(
    'POST',
    `/api/projects/${projectId}/narration/generate-project`,
    options,
  );
}
```

Implement `projectNarrationPreview` and a bounded terminal-result parser that
accepts only expected numeric/boolean/code fields from job events.

- [ ] **Step 4: Write failing panel tests**

Render with scripted, unscripted, and narrated scene fixtures. Assert:

- Engine and voice selects use the advertised provider catalog.
- Changing engine resets voice to the first voice for that engine.
- Speed defaults to 1 and stays within 0.5–2.
- Overwrite is unchecked by default and changes the preview counts.
- Start sends the exact options and subscribes to the returned job.
- Active `narration-generate-project` jobs from `jobsApi.list` are recovered on
  mount without starting a second job.
- Progress is announced politely; completion/partial failure/cancel are
  distinguishable.
- Cancel calls the existing job cancellation endpoint.
- Terminal events invalidate storyboard, affected narration, workflow-status,
  active-jobs, and render/readiness query families.
- Raw server/provider error text is not rendered.

- [ ] **Step 5: Run panel tests and confirm RED**

Run:

```bash
npm test -w @vpa/web -- src/components/ProjectNarrationPanel.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 6: Implement the panel and integrate it into NarrationPage**

Use TanStack Query for engines and active jobs. Prefer the first non-fake engine
with at least one voice; fall back to the first available engine. Keep engine,
voice, speed, and overwrite in component state. Reuse the current project
emotiveness mutation from `NarrationPage` through props:

```ts
interface ProjectNarrationPanelProps {
  projectId: string;
  scenes: Scene[];
  expressiveness: Expressiveness;
  expressivenessPending: boolean;
  onExpressivenessChange: (value: Expressiveness) => void;
}
```

Subscribe with `jobsApi.stream(jobId, onEvent)`, close the stream on unmount or
terminal event, and recover the matching active job using
`jobsApi.list({ active: true, projectId })`. The scene list stays rendered below
the panel throughout generation.

- [ ] **Step 7: Add responsive styling and page integration tests**

Add semantic classes under `.project-narration-*`. At narrow widths, make the
control grid one column and keep buttons full-width without horizontal
overflow. Test that the Narration page renders the panel once for a loaded
storyboard and continues to render scene links.

- [ ] **Step 8: Run focused web tests and confirm GREEN**

Run:

```bash
npm test -w @vpa/web -- src/lib/project-narration.test.ts src/components/ProjectNarrationPanel.test.tsx src/pages/NarrationPage.test.tsx
```

Expected: PASS with no React act warnings.

- [ ] **Step 9: Commit Task 3**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/project-narration.ts apps/web/src/lib/project-narration.test.ts apps/web/src/components/ProjectNarrationPanel.tsx apps/web/src/components/ProjectNarrationPanel.test.tsx apps/web/src/pages/NarrationPage.tsx apps/web/src/pages/NarrationPage.test.tsx apps/web/src/styles.css
git commit -m "feat(narration): add project-wide generation controls"
```

---

### Task 4: Browser acceptance, documentation, and release verification

**Files:**
- Create: `tests/e2e/project-narration.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 1–3 completed project narration workflow.
- Produces: browser acceptance evidence and user-facing documentation.

- [ ] **Step 1: Write a failing isolated browser test**

Create a deterministic project containing:

- Scene A: script, no audio.
- Scene B: whitespace-only script.
- Scene C: script with current audio.

Open the Narration page, select the fake engine/voice, and verify the preview
counts. Start with overwrite off and assert A gains audio while B is untouched
and C's audio identity remains unchanged. Start again with overwrite checked
and assert A and C are regenerated while B remains untouched. Assert ordered
progress, terminal summary, no failed network requests, no page errors, and no
horizontal overflow at 390px, 768px, and 1280px.

- [ ] **Step 2: Run the browser test and confirm RED**

Run:

```bash
npx playwright test tests/e2e/project-narration.spec.ts --config tests/e2e/playwright.config.ts
```

Expected: FAIL before the project panel workflow is available in the browser
harness.

- [ ] **Step 3: Complete the browser fixture and make acceptance GREEN**

Use only the deterministic fake TTS provider and per-test project storage.
Avoid real Gemini/xAI calls and host data. Wait for the project job's terminal
event before reading the resulting storyboard/audio endpoints.

- [ ] **Step 4: Document the workflow**

Add a README section explaining:

- Open a project's Narration page.
- Select engine, voice, speed, and emotiveness.
- Empty-script scenes are skipped and no scripts are generated.
- Existing audio is preserved unless overwrite is checked.
- Dialog speaker overrides remain in effect.
- Generation continues server-side and can be cancelled.

- [ ] **Step 5: Run targeted and full verification**

Run:

```bash
npm test -w @vpa/shared
npm test -w @vpa/server -- src/services/narration/index.test.ts src/services/narration/project-generation.test.ts src/routes/narration.test.ts
npm test -w @vpa/web -- src/lib/project-narration.test.ts src/components/ProjectNarrationPanel.test.tsx src/pages/NarrationPage.test.tsx
npm run typecheck
npm run build
npx playwright test tests/e2e/project-narration.spec.ts --config tests/e2e/playwright.config.ts
npm test
git diff --check
```

Expected: all new and existing tests pass; the one existing skipped server test
remains the only skip.

- [ ] **Step 6: Commit Task 4**

```bash
git add tests/e2e/project-narration.spec.ts README.md
git commit -m "test(narration): verify project-wide generation"
```

- [ ] **Step 7: Request final review, push, update PR #65, and merge after checks**

Review the complete range from the presentation branch base through HEAD,
resolve every Critical or Important finding, rerun the full relevant suite,
push `codex/presentation-import-design`, update PR #65's summary and test
evidence, wait for required checks, and merge without force-pushing.

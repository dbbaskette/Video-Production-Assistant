# Task-Based Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every VPA AI operation through an explicit task role so Gemini alone watches video, an independently selected writer produces scripts and editorial copy, and a separately selected general model performs non-video analysis, with global defaults, per-project overrides, reusable video briefs, and clean failures without fallback.

**Architecture:** Replace the persisted active-model flag and process-wide `SwappableLlm` with a versioned model catalog, role assignments, and a feature-facing `ModelRouter`. Add a `VideoUnderstandingService` that is the only service allowed to send video to Gemini and that caches a validated, fingerprinted brief under the project. Video-grounded writing becomes a staged pipeline: Gemini produces the brief, then the writing model receives text-only context. Routes resolve their role at request time, and settings/project APIs expose sanitized assignments and readiness to the React UI.

**Tech Stack:** TypeScript 5.6, Node.js filesystem/crypto APIs, Fastify 4, Zod 3, React 18, TanStack Query 5, Vitest, Playwright, Gemini Files API, existing provider adapters for Anthropic, Claude Code, Codex CLI, OpenAI-compatible, and fake models.

## Global Constraints

- Execute this plan after the Cap/Codex integration work is merged. Reuse its `codex-cli` provider and executable probe; do not create a second Codex adapter.
- `ModelTaskRole` has exactly three values in this release: `video-understanding`, `writing`, and `general`.
- A role resolves exactly one assigned catalog entry. Never fall back to another entry or silently switch to metadata-only behavior.
- Only a ready Gemini entry may satisfy `video-understanding`; only `VideoUnderstandingService` may send video bytes or a Gemini file URI to a model.
- The writing and general models receive text only. They must never receive the local video path, video bytes, or Gemini remote file URI.
- Project overrides contain only opaque model entry IDs. API keys and endpoints remain in the global local catalog and are never written to `project.yaml` or returned to the browser.
- Uploading and attaching media completes locally before optional AI analysis. AI failure never removes or detaches media.
- Failed regeneration never overwrites an existing scene description, script, dialog script, or lower-third set.
- A stale brief remains stale if refresh fails; the old brief may be retained for inspection but cannot be used by a grounded action.
- Deleting a model referenced by a global assignment or project override returns `409` with bounded reference metadata and does not mutate the catalog.
- Keep legacy active-model methods only while consumers are migrating. Remove `getActive`, `activate`, `active`, `SwappableLlm`, and the active-model endpoints in the final migration task.
- Preserve existing `mode: 'text' | 'video'` response fields and add routing summaries without breaking unrelated response fields.
- Log role, entry ID, provider, model, brief freshness, operation, and phase. Never log credentials, full prompts, video content, Gemini file URIs, or extracted on-screen text.
- Implement coherent end-to-end slices and run targeted tests only at task boundaries. Run the full relevant suite once before completion.

---

## File Structure

### Shared contracts

- Create `packages/shared/src/model-routing.ts` — roles, capabilities, assignment/update/response contracts, routing error codes, and project override schema.
- Create `packages/shared/src/model-routing.test.ts` — contract, clearing, unknown-role, and project schema tests.
- Create `packages/shared/src/video-understanding.ts` — bounded versioned video brief schema and freshness source metadata.
- Create `packages/shared/src/video-understanding.test.ts` — timestamp, ordering, duration, size-bound, and serialization tests.
- Modify `packages/shared/src/project.ts` and `packages/shared/src/index.ts` — persist optional snake-case project overrides and export contracts.

### Model catalog and routing

- Modify `apps/server/src/services/llm/model-registry.ts` — version 2 catalog migration, assignments, capabilities, sanitized summaries, and assignment-safe mutation.
- Create `apps/server/src/services/llm/model-registry.test.ts` — seed, v1 migration, persistence, and no-fallback assignment tests.
- Create `apps/server/src/services/llm/model-router.ts` — project/global precedence, readiness/capability validation, retry wrapping, and stable errors.
- Create `apps/server/src/services/llm/model-router.test.ts` — precedence, missing/invalid/mismatch/unavailable, and text/video isolation tests.
- Create `apps/server/src/services/llm/model-references.ts` — scan global/project references before deletion.
- Create `apps/server/src/services/llm/model-references.test.ts` — bounded reference and missing-project behavior.
- Modify `apps/server/src/services/llm/factory.ts` — expose provider readiness/capabilities and construct clients only after routing.

### Routing APIs and persistence

- Modify `apps/server/src/services/project/store.ts` and its tests — persist and clear project overrides atomically.
- Modify `apps/server/src/routes/settings.ts` and create `apps/server/src/routes/settings.test.ts` — global routing endpoints, sanitized catalog summaries, and guarded deletion.
- Modify `apps/server/src/routes/projects.ts` and its tests — project routing endpoints and resolved summaries.
- Modify `apps/server/src/server.ts` — construct and inject one `ModelRouter`.

### Web model UX

- Modify `apps/web/src/lib/api.ts` — shared routing response parsing and global/project mutations.
- Create `apps/web/src/lib/model-routing.ts` and `apps/web/src/lib/model-routing.test.ts` — selector options, compatibility filters, status copy, and attribution copy.
- Create `apps/web/src/components/ModelAssignments.tsx` — reusable global/project assignment rows.
- Modify `apps/web/src/pages/Settings.tsx` — replace Active/Use This with model capability cards and global assignments.
- Modify `apps/web/src/pages/ProjectOverview.tsx` — add project AI model overrides and resolved summaries.
- Modify `apps/web/src/styles.css` — assignment layout, badges, status, and responsive behavior.

### Video understanding and staged features

- Create `apps/server/src/services/video-understanding/index.ts` — brief freshness, generation, validation, persistence, in-flight deduplication, and cleanup.
- Create `apps/server/src/services/video-understanding/index.test.ts` — generation, reuse, invalidation, cleanup, and concurrency tests.
- Move/reuse `apps/server/src/services/video-narration/gemini-files.ts` as the private Gemini transport used by video understanding.
- Create `apps/server/src/services/video-narration/gemini-files.test.ts` — bounded upload, poll, generation, and deletion transport tests.
- Create `apps/server/prompts/video-understanding.md` — JSON-only visual/timing brief prompt.
- Modify `apps/server/src/routes/recordings.ts` and tests — local-first attachment, optional brief generation, and reanalysis from brief.
- Create `apps/server/src/services/script/video-grounded.ts` and its test — brief-to-writing-model narration.
- Modify `apps/server/src/routes/scripts.ts` and tests — two-role grounded pipeline and preservation behavior.
- Replace `apps/server/src/services/lower-thirds/video-grounded.ts` with a brief-to-writing-model implementation and update its tests.
- Modify `apps/server/src/routes/lower-thirds.ts` and tests — two-role grounded recommendations with validated segment timing.
- Modify `apps/web/src/pages/ScenePage.tsx` — role-based grounding availability, attribution, phase copy, and remediation links.

### Remaining consumers and verification

- Modify text-feature routes and `apps/server/src/server.ts` — resolve `writing` or `general` per operation instead of injecting one global client.
- Delete `apps/server/src/services/llm/swappable.ts` and remove active-model API/types/UI.
- Create `tests/e2e/model-routing.spec.ts` — global assignment, project override, two-stage grounded script, brief reuse, invalidation, and clean-failure flows.
- Create `docs/model-routing.md` — user-facing setup, role map, storage, privacy, failure, and troubleshooting documentation.

---

### Task 1: Add shared routing and video-brief contracts

**Files:**
- Create: `packages/shared/src/model-routing.ts`
- Create: `packages/shared/src/model-routing.test.ts`
- Create: `packages/shared/src/video-understanding.ts`
- Create: `packages/shared/src/video-understanding.test.ts`
- Modify: `packages/shared/src/project.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces `ModelTaskRole`, `ModelCapabilities`, `ProjectModelRouting`, `ModelRoutingResponse`, `ModelRoutingUpdate`, `ResolvedModelSummary`, and `ModelRoutingErrorCode`.
- Produces `VideoUnderstandingBrief` and `VideoUnderstandingSegment`.
- Keeps API/global role keys hyphenated while `project.yaml` uses the explicit `video_understanding` field.

- [ ] **Step 1: Write failing routing contract tests**

Cover all three roles, rejection of unknown keys, `null` as an API clearing value, omission as a project inheritance value, and `ProjectSchema` parsing with and without overrides:

```ts
expect(ModelTaskRoleSchema.options).toEqual([
  'video-understanding', 'writing', 'general',
]);

expect(ModelRoutingUpdateSchema.parse({
  assignments: { writing: 'codex-main', general: null },
})).toEqual({ assignments: { writing: 'codex-main', general: null } });

expect(() => ModelRoutingUpdateSchema.parse({
  assignments: { transcription: 'gemini' },
})).toThrow();
```

- [ ] **Step 2: Implement shared routing contracts**

Use strict schemas and bounded public error/reference shapes:

```ts
export const ModelTaskRoleSchema = z.enum([
  'video-understanding', 'writing', 'general',
]);
export type ModelTaskRole = z.infer<typeof ModelTaskRoleSchema>;

export const ModelCapabilitiesSchema = z.object({
  text: z.boolean(),
  video: z.boolean(),
});

export const ProjectModelRoutingSchema = z.object({
  video_understanding: z.string().min(1).optional(),
  writing: z.string().min(1).optional(),
  general: z.string().min(1).optional(),
}).strict().default({});

export const ModelRoutingErrorCodeSchema = z.enum([
  'model_assignment_missing',
  'model_assignment_invalid',
  'model_capability_mismatch',
  'model_unavailable',
]);
```

Define `ResolvedModelSummarySchema` with `role`, `scope: 'global' | 'project'`, entry identity, provider/model/name, capabilities, `ready`, and optional bounded `readinessMessage`. Define `ModelRoutingResponseSchema` with configured assignment IDs plus one resolved summary or error summary per role. Define updates as a strict partial record of role to `string | null`.

- [ ] **Step 3: Add project persistence without changing old files**

Extend `ProjectSchema` with:

```ts
model_routing: ProjectModelRoutingSchema.optional().default({}),
```

An existing `project.yaml` must parse to `model_routing: {}`. Serialization must use `video_understanding`, never `video-understanding`.

- [ ] **Step 4: Write failing brief validation tests**

Test finite non-negative times, `start_sec < end_sec`, monotonic segments, `end_sec <= source.duration_sec`, stable unique IDs, bounded arrays/text, and a valid round trip. Use `superRefine` assertions for cross-field checks.

- [ ] **Step 5: Implement the versioned brief schema**

Use constants and these required fields:

```ts
export const VIDEO_BRIEF_SCHEMA_VERSION = 1;
export const VIDEO_BRIEF_PROMPT_VERSION = 1;

export const VideoUnderstandingBriefSchema = z.object({
  schema_version: z.literal(VIDEO_BRIEF_SCHEMA_VERSION),
  prompt_version: z.literal(VIDEO_BRIEF_PROMPT_VERSION),
  scene_id: z.string().min(1).max(120),
  source: z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    duration_sec: z.number().finite().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  model: z.object({ entry_id: z.string(), provider: z.literal('gemini'), model: z.string() }),
  created_at: z.string().datetime(),
  visual_summary: z.string().min(1).max(4000),
  segments: z.array(VideoUnderstandingSegmentSchema).min(1).max(200),
  pacing_cues: z.array(VideoPacingCueSchema).max(100),
  narration_cues: z.array(VideoNarrationCueSchema).max(100),
  lower_third_candidates: z.array(VideoLowerThirdCandidateSchema).max(50),
}).superRefine(validateBriefTimeline);
```

Segment-linked cues must reference an existing segment ID. Bound visible labels/on-screen terms to 50 items per segment and 200 characters per item.

- [ ] **Step 6: Run the shared-contract milestone**

```bash
npm test -w @vpa/shared -- src/model-routing.test.ts src/video-understanding.test.ts
npm run typecheck -w @vpa/shared
```

Expected: selected tests pass and the shared package typechecks.

- [ ] **Step 7: Commit the shared contracts**

```bash
git add packages/shared/src/model-routing.ts packages/shared/src/model-routing.test.ts packages/shared/src/video-understanding.ts packages/shared/src/video-understanding.test.ts packages/shared/src/project.ts packages/shared/src/index.ts
git commit -m "feat: add model routing contracts"
```

---

### Task 2: Migrate the model catalog to role assignments

**Files:**
- Modify: `apps/server/src/services/llm/model-registry.ts`
- Create: `apps/server/src/services/llm/model-registry.test.ts`
- Modify: `apps/server/src/services/llm/factory.ts`

**Interfaces:**
- Produces version 2 `ModelsFile`, `getAssignment`, `setAssignments`, and capability/readiness-safe catalog summaries.
- Consumes the already-merged `codex-cli` provider from the Cap/Codex work.
- Temporarily retains legacy `getActive`/`activate` only for not-yet-migrated callers.

- [ ] **Step 1: Write migration and assignment tests first**

Use a temporary `models.json` and cover:

```ts
const legacy = {
  models: [
    { id: 'writer', name: 'Writer', provider: 'claude-code', model: 'sonnet', active: true },
    { id: 'vision', name: 'Vision', provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'secret', active: false },
  ],
};
```

After `load`, expect version 2, no persisted `active`, `writing` and `general` assigned to `writer`, `video-understanding` assigned to `vision`, and the original API key retained only on the internal entry. Also test no ready Gemini leaves video unassigned, multiple role assignments may use one ID, env merging never overwrites assignments, and an explicit `null` clears only the selected role.

- [ ] **Step 2: Implement versioned storage and atomic migration**

Replace persisted entry and file shapes with:

```ts
export interface ModelEntry {
  id: string;
  name: string;
  provider: ModelProvider;
  model: string;
  endpoint?: string;
  apiKey?: string;
}

export interface ModelsFile {
  version: 2;
  models: ModelEntry[];
  assignments: Partial<Record<ModelTaskRole, string>>;
}
```

Parse unknown disk JSON through a private Zod migration schema. Treat both unversioned and `{ version: 1 }` files as legacy. Save the migrated file before `load` resolves. Do not infer a new writer when a previous active entry exists.

- [ ] **Step 3: Centralize derived capabilities and configuration readiness**

Add pure helpers in `factory.ts`:

```ts
export function capabilitiesForProvider(provider: ModelProvider): ModelCapabilities {
  return { text: true, video: provider === 'gemini' };
}

export function configuredReadiness(entry: ModelEntry): { ready: boolean; message?: string } {
  if (entry.provider === 'gemini' || entry.provider === 'anthropic') {
    return entry.apiKey
      ? { ready: true }
      : { ready: false, message: 'API key is missing' };
  }
  if (entry.provider === 'openai-compat' && !entry.endpoint) {
    return { ready: false, message: 'Endpoint is missing' };
  }
  return { ready: true };
}
```

CLI executable checks remain injectable/asynchronous in `ModelRouter`; configuration readiness is only the static half of readiness.

- [ ] **Step 4: Add assignment mutation and sanitized listing**

Implement:

```ts
getAssignment(role: ModelTaskRole): string | undefined;
getAssignments(): Partial<Record<ModelTaskRole, string>>;
setAssignments(patch: Partial<Record<ModelTaskRole, string | null>>): Promise<void>;
list(): SanitizedModelEntry[];
```

`list()` returns `hasApiKey`, capabilities, and static readiness but never `apiKey`. `setAssignments` validates every non-null ID before changing anything, applies the patch transactionally, and saves once.

- [ ] **Step 5: Run the catalog milestone**

```bash
npm test -w @vpa/server -- src/services/llm/model-registry.test.ts src/services/llm/providers/codex-cli.test.ts
npm run typecheck -w @vpa/server
```

Expected: legacy migration, assignment mutation, sanitization, and the existing Codex provider tests pass.

- [ ] **Step 6: Commit the catalog migration**

```bash
git add apps/server/src/services/llm/model-registry.ts apps/server/src/services/llm/model-registry.test.ts apps/server/src/services/llm/factory.ts
git commit -m "feat: migrate model catalog to role assignments"
```

---

### Task 3: Build the feature-facing model router and deletion guard

**Files:**
- Create: `apps/server/src/services/llm/model-router.ts`
- Create: `apps/server/src/services/llm/model-router.test.ts`
- Create: `apps/server/src/services/llm/model-references.ts`
- Create: `apps/server/src/services/llm/model-references.test.ts`

**Interfaces:**
- Produces `resolveText(role, project?)`, `resolveVideo(project?)`, `describe(role, project?)`, and `ModelRoutingError`.
- Produces `findModelReferences(entryId, registry, store)` for guarded deletion.

- [ ] **Step 1: Write router failure and precedence tests**

Cover project override over global assignment; clearing override restores global; missing assignment; missing entry; Gemini required for video; missing key; unavailable CLI; retry-wrapped text client; and no second factory call after the selected entry fails.

Verify the stable failure contract:

```ts
await expect(router.resolveVideo(project)).rejects.toMatchObject({
  code: 'model_capability_mismatch',
  role: 'video-understanding',
  scope: 'project',
  statusCode: 422,
});
expect(createClient).not.toHaveBeenCalled();
```

- [ ] **Step 2: Implement explicit normalized project lookup**

Keep the snake/hyphen translation in one place:

```ts
const projectFieldByRole = {
  'video-understanding': 'video_understanding',
  writing: 'writing',
  general: 'general',
} as const;

function selectedId(role: ModelTaskRole, project?: Project): {
  id?: string;
  scope: 'project' | 'global';
} {
  const override = project?.model_routing[projectFieldByRole[role]];
  return override
    ? { id: override, scope: 'project' }
    : { id: registry.getAssignment(role), scope: 'global' };
}
```

- [ ] **Step 3: Implement resolution and stable public errors**

Use these result boundaries:

```ts
export interface ResolvedTextModel {
  client: LlmClient;
  summary: ResolvedModelSummary;
}

export interface ResolvedVideoModel {
  apiKey: string;
  model: string;
  summary: ResolvedModelSummary & { provider: 'gemini' };
}

export class ModelRoutingError extends Error {
  constructor(
    readonly code: ModelRoutingErrorCode,
    readonly role: ModelTaskRole,
    readonly scope: 'project' | 'global',
    message: string,
    readonly statusCode: 422 | 503,
  ) { super(message); }
}
```

`resolveText` accepts only `writing | general`. It checks static readiness, awaits the injected CLI readiness probe for `claude-code`/`codex-cli`, constructs exactly the chosen client, and wraps it in `RetryingLlm`. `resolveVideo` checks provider and key, then returns credentials without constructing a text client. `describe` catches `ModelRoutingError` and returns a sanitized not-ready summary for the UI.

- [ ] **Step 4: Write and implement reference scanning**

Return bounded references:

```ts
export interface ModelReferenceReport {
  globalRoles: ModelTaskRole[];
  projects: Array<{ id: string; name: string; roles: ModelTaskRole[] }>;
  truncated: boolean;
}
```

Scan the tracker, skip missing/unreadable project files with a private warning callback, cap project results at 50, and never include project paths. Tests must show a global reference, two project references, a missing project file, and truncation.

- [ ] **Step 5: Run the router milestone**

```bash
npm test -w @vpa/server -- src/services/llm/model-router.test.ts src/services/llm/model-references.test.ts
npm run typecheck -w @vpa/server
```

Expected: all resolution branches pass; tests prove there is no fallback selection.

- [ ] **Step 6: Commit the router slice**

```bash
git add apps/server/src/services/llm/model-router.ts apps/server/src/services/llm/model-router.test.ts apps/server/src/services/llm/model-references.ts apps/server/src/services/llm/model-references.test.ts
git commit -m "feat: add task-based model router"
```

---

### Task 4: Add global and project routing APIs

**Files:**
- Modify: `apps/server/src/services/project/store.ts`
- Modify: `apps/server/src/services/project/store.test.ts`
- Modify: `apps/server/src/routes/settings.ts`
- Create: `apps/server/src/routes/settings.test.ts`
- Modify: `apps/server/src/routes/projects.ts`
- Modify: `apps/server/src/routes/projects.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Produces `ProjectStore.setProjectModelRouting`; the reference scanner uses the existing `readTracker` and `readProject` methods.
- Produces `GET/PUT /api/settings/model-routing` and `GET/PUT /api/projects/:id/model-routing`.
- Changes model deletion to a guarded `409` operation.

- [ ] **Step 1: Add failing ProjectStore tests and atomic update**

Implement a patch API where `null` deletes the override and omission leaves it unchanged:

```ts
async setProjectModelRouting(
  id: string,
  patch: Partial<Record<ModelTaskRole, string | null>>,
): Promise<Project>
```

Translate `video-understanding` to `video_understanding`, parse the completed object through `ProjectSchema`, and atomically rewrite only `project.yaml`. Tests must prove unrelated metadata survives.

- [ ] **Step 2: Write route tests before changing endpoints**

Cover sanitized `GET /api/settings/models`, global routing read/update/clear, project inheritance/override/clear, unknown role rejection, unknown entry rejection, and deletion blocked with this shape:

```json
{
  "code": "model_in_use",
  "error": "Reassign this model before deleting it.",
  "references": {
    "globalRoles": ["writing"],
    "projects": [{ "id": "...", "name": "demo", "roles": ["general"] }],
    "truncated": false
  }
}
```

- [ ] **Step 3: Implement routing endpoints with shared parsing**

The settings endpoints return:

```ts
{
  assignments: registry.getAssignments(),
  resolved: await router.describeAll(),
}
```

Project endpoints read the project once, return its configured override object plus resolved summaries, and accept only `ModelRoutingUpdateSchema`. A `null` project value means inherit global; a `null` global value means unassigned.

- [ ] **Step 4: Replace active mutation in settings routes**

Remove model swapping from add/update/delete. Keep the legacy active read/activate endpoints through Task 8 because the current ScenePage still calls them; mark them deprecated, migrate ScenePage in Task 9, and delete them in Task 10. Updating credentials must take effect on the next routed request without a server restart.

- [ ] **Step 5: Wire one registry/router into Fastify**

Construct:

```ts
const modelRouter = new ModelRouter({
  registry: modelRegistry,
  createClient: createLlmFromEntry,
  checkCliReady,
  warn: (fields, message) => app.log.warn(fields, message),
});
```

Inject `modelRouter` into settings/project routes. Do not yet remove the legacy `llm` injection from other routes.

- [ ] **Step 6: Run the API milestone**

```bash
npm test -w @vpa/server -- src/services/project/store.test.ts src/routes/settings.test.ts src/routes/projects.test.ts
npm run typecheck -w @vpa/server
```

Expected: both routing APIs and guarded deletion pass with no credentials in serialized responses.

- [ ] **Step 7: Commit the API slice**

```bash
git add apps/server/src/services/project/store.ts apps/server/src/services/project/store.test.ts apps/server/src/routes/settings.ts apps/server/src/routes/settings.test.ts apps/server/src/routes/projects.ts apps/server/src/routes/projects.test.ts apps/server/src/server.ts
git commit -m "feat: expose global and project model routing"
```

---

### Task 5: Replace active-model UX with global assignments and project overrides

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/model-routing.ts`
- Create: `apps/web/src/lib/model-routing.test.ts`
- Create: `apps/web/src/components/ModelAssignments.tsx`
- Modify: `apps/web/src/pages/Settings.tsx`
- Modify: `apps/web/src/pages/ProjectOverview.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces `settingsApi.getModelRouting/updateModelRouting` and `api.getProjectModelRouting/updateProjectModelRouting`.
- Produces one reusable assignment component with global and project modes.

- [ ] **Step 1: Add typed API methods and parse every routing response**

Use shared schemas rather than type assertions:

```ts
async getModelRouting(): Promise<ModelRoutingResponse> {
  return ModelRoutingResponseSchema.parse(
    await request('GET', '/api/settings/model-routing'),
  );
}

async updateModelRouting(update: ModelRoutingUpdate): Promise<ModelRoutingResponse> {
  return ModelRoutingResponseSchema.parse(
    await request('PUT', '/api/settings/model-routing', update),
  );
}
```

Mirror these methods under project URLs.

- [ ] **Step 2: Write pure view-model tests**

Because web Vitest currently runs without a DOM, keep selector logic pure. Cover:

```ts
expect(optionsForRole(models, 'video-understanding').map((m) => m.id))
  .toEqual(['gemini-pro']);
expect(optionsForRole(models, 'writing').map((m) => m.id))
  .toEqual(['gemini-pro', 'claude', 'codex']);
expect(modelAttribution(video, writer))
  .toBe('Gemini Pro watches the recording; Codex writes the script.');
```

Also test inherited project copy, missing assignment, incompatible assignment, unavailable CLI, and remediation destination.

- [ ] **Step 3: Build `ModelAssignments`**

Use fixed labels and helper text:

```ts
const rows = [
  ['video-understanding', 'Watch and analyze video', 'Creates visual and timing briefs from recordings.'],
  ['writing', 'Write and refine content', 'Writes scripts, ideas, shot plans, and lower-third copy.'],
  ['general', 'General analysis', 'Reviews quality, source documents, and brand information.'],
] as const;
```

Global mode offers `Not assigned`; project mode offers `Use global setting`. Show selected scope, resolved provider/model, Text/Video badges, and bounded readiness copy. Save one row immediately with a disabled in-flight selector and show the previous value if the mutation fails.

- [ ] **Step 4: Rewrite Settings model cards**

Remove `Active` and `Use This`. Keep add/edit/delete/test controls. Add capability badges and readiness. Put **Model assignments** above the model library so the user configures intent before managing entries. When deletion returns `model_in_use`, render its role/project references and keep the card.

- [ ] **Step 5: Add Project Overview overrides**

Add an **AI models** section near project metadata. Each row defaults to global, displays the resolved model, and links to global Settings when inherited configuration is missing or unhealthy.

- [ ] **Step 6: Run the web milestone**

```bash
npm test -w @vpa/web -- src/lib/model-routing.test.ts
npm run typecheck -w @vpa/web
npm run build -w @vpa/web
```

Expected: pure routing UX tests pass, and the React app typechecks/builds while the temporary ScenePage active-model compatibility call remains until Task 9.

- [ ] **Step 7: Commit the model settings UX**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/model-routing.ts apps/web/src/lib/model-routing.test.ts apps/web/src/components/ModelAssignments.tsx apps/web/src/pages/Settings.tsx apps/web/src/pages/ProjectOverview.tsx apps/web/src/styles.css
git commit -m "feat: add model assignment settings"
```

---

### Task 6: Create the reusable Gemini video-understanding service

**Files:**
- Create: `apps/server/src/services/video-understanding/index.ts`
- Create: `apps/server/src/services/video-understanding/index.test.ts`
- Create: `apps/server/prompts/video-understanding.md`
- Modify: `apps/server/src/services/video-narration/gemini-files.ts`
- Create: `apps/server/src/services/video-narration/gemini-files.test.ts`
- Modify: `apps/server/src/services/recording/metadata.ts`
- Modify: `apps/server/src/services/recording/metadata.test.ts`

**Interfaces:**
- Produces `VideoUnderstandingService.ensureBrief`, `readBriefStatus`, and phase callbacks.
- Consumes `ResolvedVideoModel`, `probeVideo`, the Gemini transport, and shared brief schema.

- [ ] **Step 1: Write freshness and isolation tests**

Use injected filesystem/hash/probe/Gemini functions. Cover:

- missing artifact generates once;
- matching source hash, entry ID, concrete model, schema, and prompt reuses without upload;
- changed bytes, model entry, concrete model, schema, or prompt invalidates;
- two concurrent identical calls share one upload/generation promise;
- invalid JSON/model output is not persisted;
- Gemini delete runs in `finally` after success or generation failure;
- delete failure logs privately and does not fail a valid result;
- stale artifact is not returned when refresh fails.

- [ ] **Step 2: Add file hashing and complete metadata probing**

Keep the existing `VideoMetadata` duration/width/height fields and add an exported streaming SHA-256 helper beside the probe. Do not read the whole video into memory:

```ts
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}
```

- [ ] **Step 3: Author the JSON-only Gemini prompt**

The prompt must request only the shared schema's model-produced fields: visual summary, timestamped segments, pacing/narration cues, and lower-third candidates. It must instruct the model to use seconds, stay within the supplied duration, use stable `segment-001` IDs in time order, preserve visible product terms, avoid secrets, and return JSON without fences. VPA supplies source/model/version fields after validation.

- [ ] **Step 4: Implement artifact freshness and safe persistence**

Use:

```ts
export interface EnsureBriefInput {
  projectPath: string;
  sceneId: string;
  sceneName: string;
  videoPath: string;
  videoMimeType?: string;
}

export type VideoUnderstandingPhase =
  | 'hashing' | 'uploading' | 'processing' | 'analyzing' | 'validating' | 'saving' | 'done';
```

Write to `join(projectPath, 'analysis', 'video', `${sceneId}.json`)` after rejecting scene IDs outside `[A-Za-z0-9_-]+`. Parse existing artifacts through `VideoUnderstandingBriefSchema`. Compare all freshness fields before reuse. Persist with `atomicWriteFile` only after full schema validation.

- [ ] **Step 5: Implement Gemini generation and in-flight deduplication**

Key the in-flight map by:

```ts
`${projectPath}\0${sceneId}\0${sha256}\0${entryId}\0${model}\0${schemaVersion}\0${promptVersion}`
```

Upload and wait using the existing Files API adapter; call `generateWithVideo` with `responseMimeType: 'application/json'`; strip no Markdown beyond a single defensive JSON fence; parse, combine VPA-owned metadata, validate, save, and best-effort delete the remote file in `finally`. Remove the in-flight entry in a second `finally`.

- [ ] **Step 6: Run the video-understanding milestone**

```bash
npm test -w @vpa/server -- src/services/video-understanding/index.test.ts src/services/recording/metadata.test.ts src/services/video-narration/gemini-files.test.ts
npm run typecheck -w @vpa/server
```

Expected: freshness, deduplication, validation, and cleanup tests pass without network access.

- [ ] **Step 7: Commit the reusable brief service**

```bash
git add apps/server/src/services/video-understanding/index.ts apps/server/src/services/video-understanding/index.test.ts apps/server/prompts/video-understanding.md apps/server/src/services/video-narration/gemini-files.ts apps/server/src/services/recording/metadata.ts apps/server/src/services/recording/metadata.test.ts
git commit -m "feat: add reusable Gemini video briefs"
```

---

### Task 7: Route recording analysis through Gemini without risking uploads

**Files:**
- Modify: `apps/server/src/routes/recordings.ts`
- Modify: `apps/server/src/routes/recordings.test.ts`
- Modify: `apps/server/src/services/video-analysis/index.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Recording routes consume `ModelRouter` and `VideoUnderstandingService`.
- Reanalysis derives proposals from `VideoUnderstandingBrief`; direct video generation in `video-analysis` is removed.

- [ ] **Step 1: Add preservation-first route tests**

Cover:

- upload succeeds and recording remains attached when `video-understanding` is unassigned;
- response marks `analysis.status: 'failed'` with stable routing code and remediation;
- Gemini failure does not delete the local file or mutate existing scene metadata;
- grounded reanalysis returns a dry-run proposal based on the brief;
- explicit apply updates metadata only after proposal validation;
- grounded reanalysis never calls metadata-only analysis on failure;
- text-only reanalysis resolves `general` and remains available when explicitly requested.

- [ ] **Step 2: Make attachment the transaction boundary**

Complete multipart persistence, metadata probing, storyboard recording update, and response-safe attachment data before starting optional brief generation. Represent post-attachment analysis separately:

```ts
type RecordingAnalysisResult =
  | { status: 'ready'; model: ResolvedModelSummary; briefFreshness: 'generated' | 'reused' }
  | { status: 'failed'; code: ModelRoutingErrorCode | 'video_analysis_failed'; message: string };
```

Do not throw an HTTP failure after attachment is committed; return `201` with `analysis.status: 'failed'`.

- [ ] **Step 3: Replace provider checks with role resolution**

For grounded reanalysis:

```ts
const videoModel = await router.resolveVideo(project);
const brief = await videoUnderstanding.ensureBrief(input, videoModel, onPhase);
const proposal = proposeSceneMetadataFromBrief(scene, brief);
```

The proposal helper is deterministic and bounded; it does not make a second model call. Preserve dry-run/apply behavior. Map `ModelRoutingError` to its stable public code and log the provider diagnostic privately.

- [ ] **Step 4: Remove direct Gemini use from video analysis**

Delete or refactor functions in `services/video-analysis` that upload video. Keep only pure brief-to-scene proposal helpers and explicit text-only analysis that receives an already resolved `general` client.

- [ ] **Step 5: Run the recording milestone**

```bash
npm test -w @vpa/server -- src/routes/recordings.test.ts src/services/video-analysis/index.test.ts src/services/recording/ingest.test.ts
npm run typecheck -w @vpa/server
```

Expected: local-first upload and no-fallback preservation tests pass.

- [ ] **Step 6: Commit recording integration**

```bash
git add apps/server/src/routes/recordings.ts apps/server/src/routes/recordings.test.ts apps/server/src/services/video-analysis/index.ts apps/server/src/services/video-analysis/index.test.ts apps/server/src/server.ts
git commit -m "feat: route recording analysis through video briefs"
```

---

### Task 8: Stage video-grounded scripts through Gemini and the writing model

**Files:**
- Create: `apps/server/src/services/script/video-grounded.ts`
- Create: `apps/server/src/services/script/video-grounded.test.ts`
- Modify: `apps/server/src/routes/scripts.ts`
- Modify: `apps/server/src/routes/scripts.test.ts`
- Modify: `apps/server/src/services/video-narration/index.ts`
- Modify: `apps/server/src/services/project-source-docs/context.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Produces a text-only `generateScriptFromVideoBrief` service.
- Script route resolves `video-understanding`, optional `general` source summarization, and `writing` explicitly.

- [ ] **Step 1: Write provider-boundary and preservation tests**

Use distinct Gemini transport and writer doubles. Assert:

```ts
expect(gemini.generateWithVideo).toHaveBeenCalledTimes(1);
expect(writer.complete).toHaveBeenCalledWith(expect.objectContaining({
  user: expect.stringContaining('segment-001'),
}));
expect(writer.complete.mock.calls[0]![0].user).not.toContain(videoPath);
expect(writer.complete.mock.calls[0]![0].user).not.toContain('generativelanguage.googleapis.com');
```

Also cover text-only generation uses `writing` without resolving video; source-doc summarization uses `general`; writer failure preserves existing script/dialog; Gemini failure never calls the writer; dialog conversion uses the same writing assignment; and no fallback client is created.

- [ ] **Step 2: Build bounded brief context for the writer**

Implement:

```ts
export interface VideoGroundedScriptInput {
  sceneName: string;
  sceneDescription: string;
  sceneIntent?: string;
  durationSec: number;
  projectObjective?: string;
  projectAudience?: string;
  sourceContext?: string;
  brief: VideoUnderstandingBrief;
}

export async function generateScriptFromVideoBrief(
  input: VideoGroundedScriptInput,
  writer: LlmClient,
  workspaceRoot: string,
): Promise<string>;
```

Serialize only visual summary, ordered segments, relevant labels/terms, pacing cues, and narration cues. Cap the serialized brief context at the existing prompt budget while retaining segment IDs and times. Tell the writer to treat the brief as visual truth and source docs as factual truth.

- [ ] **Step 3: Refactor the script route into explicit stages**

Order grounded generation exactly:

```ts
const project = await store.readProject(projectId);
const videoModel = await router.resolveVideo(project);
const writer = await router.resolveText('writing', project);
const general = sourceDocsNeedSummarization
  ? await router.resolveText('general', project)
  : undefined;
const brief = await videoUnderstanding.ensureBrief(briefInput, videoModel, onPhase);
const sourceContext = await loadProjectSourceContext(project.path, general?.client);
const script = await generateScriptFromVideoBrief(context, writer.client, workspaceRoot);
const dialog = await convertToDialog(script, writer.client, workspaceRoot);
await persistValidatedScripts(script, dialog);
```

Resolve every required role before expensive upload work. Keep generated values in memory and update the storyboard once both required outputs validate.

- [ ] **Step 4: Retire direct Gemini script generation**

Remove `generateVideoGroundedScript` or convert its exports to the new text-only service. No code under `services/video-narration` may call `generateWithVideo` after this task; only `VideoUnderstandingService` may import the Gemini transport.

- [ ] **Step 5: Add routing summaries to the feature response**

Return:

```ts
{
  mode: 'video',
  routing: {
    videoUnderstanding: videoModel.summary,
    writing: writer.summary,
    general: general?.summary,
  },
  briefFreshness,
  script,
  dialog,
}
```

Public failures include stable routing code and role; provider diagnostics remain in structured server logs.

- [ ] **Step 6: Run the script milestone**

```bash
npm test -w @vpa/server -- src/services/script/video-grounded.test.ts src/routes/scripts.test.ts src/services/script/convert-to-dialog.test.ts src/services/project-source-docs/context.test.ts
npm run typecheck -w @vpa/server
```

Expected: two-stage isolation and preservation tests pass, and no direct video-to-writer path remains.

- [ ] **Step 7: Commit the staged script pipeline**

```bash
git add apps/server/src/services/script/video-grounded.ts apps/server/src/services/script/video-grounded.test.ts apps/server/src/routes/scripts.ts apps/server/src/routes/scripts.test.ts apps/server/src/services/video-narration/index.ts apps/server/src/services/project-source-docs/context.ts apps/server/src/server.ts
git commit -m "feat: stage grounded scripts across video and writing models"
```

---

### Task 9: Stage lower thirds and make scene UX routing-aware

**Files:**
- Modify: `apps/server/src/services/lower-thirds/video-grounded.ts`
- Modify/Create: `apps/server/src/services/lower-thirds/video-grounded.test.ts`
- Modify: `apps/server/src/routes/lower-thirds.ts`
- Modify: `apps/server/src/routes/lower-thirds.test.ts`
- Modify: `apps/web/src/pages/ScenePage.tsx`
- Modify: `apps/web/src/lib/model-routing.ts`
- Modify: `apps/web/src/lib/model-routing.test.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Lower-thirds service consumes a validated brief and a resolved writing client; it does not upload video.
- ScenePage consumes project routing, not the legacy active model.

- [ ] **Step 1: Write segment anchoring and preservation tests**

Have the writer return segment IDs plus copy, never raw times:

```json
[
  { "segment_id": "segment-002", "title": "Model routing", "subtitle": "One model per task", "style": "frosted" }
]
```

Test unknown segment IDs, duplicates, out-of-order selections, maximum item count, invalid style, writer failure preserving existing lower thirds, Gemini failure not calling writer, and the writer prompt containing no path/file URI.

- [ ] **Step 2: Replace direct video recommendation with brief-to-copy generation**

Implement:

```ts
export async function recommendLowerThirdsFromBrief(
  input: VideoLtInput & { brief: VideoUnderstandingBrief },
  writer: LlmClient,
  workspaceRoot: string,
): Promise<LowerThird[]>;
```

Validate writer JSON with Zod. Map `segment_id` to the brief segment and derive `in_sec/out_sec` server-side, clamped to that segment and source duration. Reject model-provided raw times.

- [ ] **Step 3: Route lower-thirds requests through both roles**

Grounded mode resolves video and writing, ensures the brief, writes copy, validates the complete set, then replaces persisted lower thirds once. Text-only mode resolves only writing. Return routing summaries and brief freshness in the response.

- [ ] **Step 4: Replace active-model ScenePage queries**

Query project model routing and derive:

```ts
const videoRoute = routing.resolved['video-understanding'];
const writingRoute = routing.resolved.writing;
const canGroundInVideo = !!scene?.recording && videoRoute?.ready === true;
```

When recording exists, keep grounding selected by default. If the video role is missing/unhealthy, keep the toggle visible but disabled, show the exact role error, and link to the project's **AI models** section. Never silently submit `groundInVideo: false` after the user requested grounding.

- [ ] **Step 5: Add transparent attribution and phase copy**

Use plain-language copy from pure helpers:

- `Gemini 2.5 Pro watches the recording; Codex writes the script.`
- `Reusing the current Gemini timing brief.`
- `The video model is not ready. Your existing script will not be changed.`

Update reanalysis, script, and lower-third progress phases from “Gemini writes” to “Gemini analyzes → writer drafts”.

- [ ] **Step 6: Run the grounded-feature milestone**

```bash
npm test -w @vpa/server -- src/services/lower-thirds/video-grounded.test.ts src/routes/lower-thirds.test.ts
npm test -w @vpa/web -- src/lib/model-routing.test.ts
npm run typecheck -w @vpa/server
npm run typecheck -w @vpa/web
npm run build -w @vpa/web
```

Expected: lower-third times come only from validated segments and the Scene UI builds without `getActiveModel`.

- [ ] **Step 7: Commit lower thirds and Scene UX**

```bash
git add apps/server/src/services/lower-thirds/video-grounded.ts apps/server/src/services/lower-thirds/video-grounded.test.ts apps/server/src/routes/lower-thirds.ts apps/server/src/routes/lower-thirds.test.ts apps/web/src/pages/ScenePage.tsx apps/web/src/lib/model-routing.ts apps/web/src/lib/model-routing.test.ts apps/web/src/styles.css
git commit -m "feat: route grounded scene tools by model role"
```

---

### Task 10: Migrate every remaining text consumer and remove global swapping

**Files:**
- Modify: `apps/server/src/routes/brands.ts`
- Modify: `apps/server/src/routes/ideation.ts`
- Modify: `apps/server/src/routes/shot-plan.ts`
- Modify: `apps/server/src/routes/narration.ts`
- Modify: `apps/server/src/routes/quality-review.ts`
- Modify: `apps/server/src/routes/setup.ts`
- Modify: corresponding route tests
- Modify: `apps/server/src/services/recording/propose-boundaries.ts`
- Modify: `apps/server/src/services/tts/expressiveness.ts`
- Modify: `apps/server/src/services/setup/probes.ts`
- Modify: `apps/server/src/routes/settings.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/web/src/lib/api.ts`
- Delete: `apps/server/src/services/llm/swappable.ts`
- Delete/Modify: `apps/server/src/services/llm/swappable.test.ts`

**Role map:**

| Operation | Role |
|---|---|
| Ideation and storyboard proposals | `writing` |
| Shot-plan generation | `writing` |
| Script tighten/polish/dialog and narration expressiveness copy | `writing` |
| Lower-third text-only recommendations | `writing` |
| Brand extraction and rationale | `general` |
| Quality review | `general` |
| Source-document summarization | `general` |
| Recording boundary proposals and utility classification | `general` |
| Setup/readiness display | all three, independently described |

- [ ] **Step 1: Update route tests to require explicit role resolution**

Replace shared fake `llm` fixtures with a fake router that records roles. Add one assertion per route group, for example:

```ts
expect(router.resolveText).toHaveBeenCalledWith('writing', expect.objectContaining({ id: projectId }));
expect(router.resolveText).not.toHaveBeenCalledWith('general', expect.anything());
```

For brand routes without a project, resolve the global `general` assignment. For each failure, assert the existing persisted data remains unchanged and the response contains the stable routing code.

- [ ] **Step 2: Migrate writing consumers as one coherent slice**

Change route dependencies from `llm: LlmClient` to `router: ModelRouter`. Read the project at the route boundary, resolve `writing`, then pass `resolved.client` into existing service functions. Do not add router lookups inside prompt helpers that already receive a client.

- [ ] **Step 3: Migrate general consumers as one coherent slice**

Resolve `general` for brand generation, quality review, source summarization, boundary proposals, and utility analysis. Helpers called by a writing feature may explicitly receive the separately resolved general client; they must not reuse the writer implicitly.

- [ ] **Step 4: Make setup probe assignments independently**

Replace the single LLM probe with three routing readiness rows. Configuration/readiness checks must not issue billable completions. CLI roles use executable probes; API roles use bounded configuration checks. The setup response must distinguish missing assignment from unavailable provider.

- [ ] **Step 5: Remove the process-wide client and legacy active APIs**

Delete construction and injection of `SwappableLlm` in `server.ts`. Delete `swappable.ts` and its tests. Remove `active` from all entry types, `getActive`/`activate` from the registry, and these endpoints/client methods:

```text
POST /api/settings/models/:id/activate
GET  /api/settings/models/active
settingsApi.activateModel
settingsApi.getActiveModel
```

Use `rg` to prove no runtime consumer remains:

```bash
rg -n "SwappableLlm|getActive\(|activate\(|models/active|/activate|\.active\b" apps packages
```

Expected: no matches except migration fixtures/docs that intentionally mention legacy `active`.

- [ ] **Step 6: Run all migrated route tests**

```bash
npm test -w @vpa/server -- src/routes/brands.test.ts src/routes/ideation.test.ts src/routes/shot-plan.test.ts src/routes/narration.test.ts src/routes/quality-review.test.ts src/routes/setup.test.ts
npm run typecheck -w @vpa/server
npm run typecheck -w @vpa/web
```

Expected: every AI route proves its task role and the server has no global LLM client.

- [ ] **Step 7: Commit the consumer migration**

```bash
git add apps/server/src apps/web/src/lib/api.ts
git commit -m "refactor: route all AI features by task role"
```

---

### Task 11: Add end-to-end coverage, documentation, and final verification

**Files:**
- Create: `tests/e2e/model-routing.spec.ts`
- Create: `docs/model-routing.md`
- Modify: `README.md`
- Modify: any fixtures needed under `tests/e2e/fixtures/`

**Interfaces:**
- Produces fake-backed browser coverage for global/project configuration and staged grounded workflows.
- Documents user-visible roles, privacy, local brief reuse, and clean failure behavior.

- [ ] **Step 1: Add deterministic fake provider hooks for E2E**

Use test-only injected providers, not live Gemini/Claude/Codex. The fake video transport records the input path and emits a valid brief; the fake writer records text input and emits script/lower-third JSON. Expose recorded calls only to the test harness, never production routes.

- [ ] **Step 2: Implement the primary E2E flow**

Cover this sequence in one test:

1. Configure Gemini as **Watch and analyze video**.
2. Configure Codex fake as **Write and refine content** and Claude fake as **General analysis**.
3. Override only writing for one project.
4. Attach a recording.
5. Generate a grounded script and verify routing attribution names two different models.
6. Generate lower thirds and verify the existing brief is reused.
7. Change the project video assignment and verify the brief regenerates.
8. Clear the override and verify the global model resolves again.

- [ ] **Step 3: Implement clean-failure E2E cases**

Cover missing video assignment, unavailable writer, and blocked deletion. Verify attached recording and existing authored content remain visible after each failure, there is no automatic fallback, and remediation links open the right global/project assignment section.

- [ ] **Step 4: Write operating and privacy documentation**

Document:

- what each role does and the recommended Gemini + Claude/Codex setup;
- global defaults versus project overrides;
- that only Gemini receives video and writers receive a local structured text brief;
- artifact path and invalidation rules;
- no-fallback behavior and stable error remediation;
- how to reassign before deleting a model;
- migration from the old active model;
- how to inspect/remove a local brief without touching the recording.

Link `docs/model-routing.md` from the README.

- [ ] **Step 5: Run the complete verification gate**

```bash
npm test
npm run typecheck
npm run build
npm run e2e -- tests/e2e/model-routing.spec.ts
rg -n "SwappableLlm|getActive\(|models/active|/activate" apps packages
rg -n "generateWithVideo|uploadVideo|waitForFileActive" apps/server/src --glob '!**/*.test.ts'
```

Expected:

- all repository tests, typechecks, and builds pass;
- the routing E2E passes;
- the first search returns no runtime legacy active-model path;
- the second search returns imports/calls only inside `services/video-understanding` and the private Gemini transport module.

- [ ] **Step 6: Perform a manual browser acceptance pass**

Start the app, then verify at desktop and narrow widths:

- Settings has three assignments and no Active/Use This affordance;
- incompatible models do not appear in the video selector;
- Project Overview can inherit, override, and clear each role;
- ScenePage names the video and writing models near grounded actions;
- a missing/unhealthy video role disables grounding with an actionable link;
- an unavailable writer fails without altering existing content;
- uploads remain attached after analysis failure.

- [ ] **Step 7: Commit E2E and documentation**

```bash
git add tests/e2e/model-routing.spec.ts tests/e2e/fixtures docs/model-routing.md README.md
git commit -m "test: verify task-based model routing end to end"
```

---

## Final Review Checklist

- [ ] Every feature requests a semantic role; no feature inspects provider names to choose its workflow.
- [ ] Only the video service imports the Gemini Files API transport.
- [ ] Gemini creates a validated local brief; the writer receives only bounded text context.
- [ ] Global assignment and project override precedence match the approved design.
- [ ] Missing, invalid, incompatible, and unavailable assignments fail with stable codes and no fallback.
- [ ] Media attachments and existing authored artifacts survive every AI failure path.
- [ ] Model deletion is blocked for both global and project references.
- [ ] API responses and logs contain no credentials, video content, file URI, full prompt, or extracted-text artifact.
- [ ] Catalog migration preserves the old active model as writing/general and selects only a ready Gemini for video.
- [ ] No placeholder, `TODO`, `TBD`, skipped test, or legacy active-model runtime path remains.
- [ ] Full tests, typecheck, build, E2E, and manual browser acceptance have passed.

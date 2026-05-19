# Scene Shot Plan — Design

**Status:** Approved for planning
**Date:** 2026-05-19

## Problem

After ideation produces a storyboard, the user records each scene themselves. Today there is no help between "scene description approved" and "video uploaded." The scene `description` field is written for the *viewer* ("what the audience will see") — not for the *operator* ("what to click, what to type, in what order"). Users have to translate the viewer-facing description into a concrete recording plan in their head, which slows recording and produces takes that drift from what the storyboard intended.

## Goal

Add an optional, per-scene **Shot Plan** step that lives between storyboard approval and recording upload. For any scene the user chooses, they can open a chat with the AI that produces a numbered, step-by-step recording script ("Open Terminal. Type `npm run dev` and press Enter. Wait for 'ready on http://…'"). They refine via chat, accept, and the saved plan renders as a checklist (and an optional printable runbook) to follow while recording.

The feature is **strictly opt-in**. Scenes without a shot plan look and behave exactly as they do today; recording upload is never gated by shot-plan state.

## Non-goals

- Auto-generating shot plans for all scenes at storyboard creation time. Users opt in per scene.
- Stateful recording flow (e.g. "step 4 complete"). The plan is a guide, not a state machine. Checkbox ticks during recording are ephemeral UI state, not persisted.
- Cross-scene continuity in v1 (the AI considers one scene at a time). The single-scene prompt can be extended later with prior-scene context if the need is real.
- Modeling step types (click vs. wait vs. observe), duration estimates, or screenshot anchors. YAGNI — the `action` string + optional `note` covers the demo-recording use case described.

## Architecture

A new `services/shot-plan/` module manages per-scene chat sessions in memory (mirror of `services/ideation/`). Four routes scoped under `/api/projects/:id/scenes/:sceneId/shot-plan` handle GET/POST/POST/DELETE for state, message, accept, and clear. A new prompt file feeds the LLM scene-level + project-level context and instructs it to return a fenced JSON block of steps alongside conversational text. Accepted plans persist into `storyboard.yaml` as two new optional fields on `SceneSchema`. The UI adds a `ShotPlanSection` to `ScenePage` and a standalone print view route.

The design reuses the proven Ideation pattern (in-memory `Manager` + JSON-block-in-chat parsing + accept persists to disk) so the engineering surface area is small and the failure modes are already understood in this codebase.

## Data model

In `packages/shared/src/storyboard.ts`, `SceneSchema` gains two optional fields:

```ts
shot_plan: z.array(z.object({
  index: z.number().int().nonnegative(),
  action: z.string().min(1),       // "Type `npm run dev` and press Enter"
  note: z.string().optional(),     // "Wait for 'ready on http://localhost:5173'"
})).optional(),
shot_plan_chat: z.array(z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  at: z.string().datetime(),
})).optional(),
```

Both fields are optional with no default. Existing `storyboard.yaml` files load unchanged — no migration script needed. `shot_plan_chat` persists so the user can re-open a `Refine` session after the in-memory session has been evicted (server restart, time-based cleanup, switching scenes).

## Routes

```
GET    /api/projects/:id/scenes/:sceneId/shot-plan
POST   /api/projects/:id/scenes/:sceneId/shot-plan/message
POST   /api/projects/:id/scenes/:sceneId/shot-plan/accept
DELETE /api/projects/:id/scenes/:sceneId/shot-plan
```

- **GET** returns the session state: `{ transcript, proposedSteps, savedPlan }`. If an in-memory session exists, returns its current transcript and any unsaved `proposedSteps`, plus the on-disk `savedPlan`. If no in-memory session exists, returns `{ transcript: scene.shot_plan_chat ?? [], proposedSteps: [], savedPlan: scene.shot_plan ?? null }` — rehydrated from disk so the UI can render the accepted view or resume a prior conversation (via Refine, which then creates a fresh in-memory session preloaded with the transcript).
- **POST /message** body `{ content: string }` → returns `{ reply: string, proposedSteps: Step[] }`. The reply is the conversational portion of the assistant's response (the JSON block is stripped). `proposedSteps` is the latest parsed step list — empty array if the assistant didn't include one this turn.
- **POST /accept** writes the current session's `proposedSteps` to `scene.shot_plan` and the full transcript to `scene.shot_plan_chat`, then clears the in-memory session. Returns the updated scene.
- **DELETE** clears `scene.shot_plan` and `scene.shot_plan_chat` and any in-memory session. Returns the updated scene.

Routes follow the existing error envelope: `{ error: string, code: string }` with status codes documented in the Error handling section.

## Service module

```
apps/server/src/services/shot-plan/
  index.ts        — ShotPlanManager class, ShotPlanSession class, JSON parser
  index.test.ts
```

`ShotPlanManager` holds sessions keyed by `${projectId}:${sceneId}`. `getOrCreate(projectId, sceneId, scene)` returns a session, hydrating its transcript from `scene.shot_plan_chat` on first creation. `get(...)` returns the existing session or null. `clear(...)` evicts.

`ShotPlanSession` mirrors `IdeationSession`: holds the transcript and `proposedSteps`, exposes `sendMessage(content, llm, scene, project, projectPath) → { reply, proposedSteps }`. The send call assembles the prompt (system + transcript + new user turn), invokes the LLM, parses the response for a JSON `{ steps: [...] }` block, updates internal state, and returns the conversational reply + latest proposed steps.

JSON parsing is the same fence-and-parse used by Ideation. Malformed or missing JSON → `proposedSteps` unchanged, conversational reply still returned.

## Prompt

New file `prompts/scene-shot-plan.md`. System message gives the model:

- Scene name, description, intent, type.
- Project objective, audience.
- List of source-doc filenames (the model can ask the user to share specific content from one if needed — actual file content is not auto-injected for v1).
- An example of the expected response shape (conversational text + a fenced ```json {"steps":[...]} ``` block).
- Guidance on granularity: "literal keystrokes, exact commands, exact URLs when known; ask the user when not known; keep each step a single observable action."

The conversational portion of the response is shown verbatim to the user as the assistant turn; the JSON block is stripped from the displayed reply and parsed into `proposedSteps`.

## UI

### `ShotPlanSection.tsx` — placed on `ScenePage` above `RecordingUpload`

Three view states, switched on session/scene state:

**Empty / opt-in.** Title "Shot Plan", one-line helper ("Optional: get a step-by-step recording script the AI generates from this scene's intent."), single `Plan shots` button. Deliberately small footprint so the section doesn't compete visually with the recording upload below it for users who don't want this feature.

**Chat in progress.** Replaces the empty state when a session exists. Two-column layout: left = chat transcript using the existing `ChatMessage` component, with an input row at the bottom; right = current `proposedSteps` numbered list with an `Accept plan` button (disabled when empty) and a `Cancel` link (clears the in-memory session via DELETE on the message endpoint — see Error handling for the exact mechanic). Closing the page mid-conversation does not lose the session — the server holds it, and re-opening the page restores it via GET.

**Accepted.** Renders `scene.shot_plan` as a numbered checklist. Checkboxes are local UI state only (not persisted). Footer actions:

- `Open print view` → opens `/projects/:id/scenes/:sceneId/shot-plan/print` in a new tab.
- `Refine` → re-opens the chat with `shot_plan_chat` as the starting transcript, returning to the chat-in-progress state.
- `Discard plan` → DELETE, confirms first.

### `ShotPlanPrintView.tsx`

Print-friendly page rendered at `/projects/:id/scenes/:sceneId/shot-plan/print`. No nav, no app chrome. Numbered list with `action` and (if present) `note`. CSS `@media print` rules tuned for paper and second-monitor reading. Page also works on mobile screens so users can prop a phone next to their recording setup.

### Project-level runbook

A second print route `/projects/:id/shot-plans/print` renders every scene's `shot_plan` in storyboard order as one continuous document, each scene as a section. Skips scenes without a plan. Used as a printable runbook before a multi-scene recording session.

### Passive indicator on storyboard list

`StoryboardView` / scene cards gain a small checklist glyph next to scenes whose `shot_plan` is present. No glyph when absent — empty case looks identical to today.

### API client (`apps/web/src/lib/api.ts`)

Adds:

```ts
shotPlanApi = {
  get(projectId, sceneId),
  sendMessage(projectId, sceneId, content),
  accept(projectId, sceneId),
  discard(projectId, sceneId),
}
```

### Targeted refactor

The JSON-block extraction logic currently lives inline in `apps/web/src/pages/Ideation.tsx`. As part of this work, lift it into `apps/web/src/lib/parse-json-block.ts` so both Ideation and Shot Plan use one implementation. No behavior change to Ideation.

## Error handling

| Condition | Response | UI behavior |
|---|---|---|
| LLM call fails (network, rate limit, malformed response from upstream) | `502` `{ error, code: 'llm_error' }` | Inline retry button in chat panel, transcript preserved. |
| Assistant response has no parseable JSON block | `200` with `reply` set, `proposedSteps: []` | Reply rendered as normal assistant turn, proposed-steps panel unchanged. |
| Accept with empty proposed steps | `400` `{ code: 'no_steps' }` | Defensive — Accept button is disabled in the UI when empty. |
| Scene id not found | `404` `{ code: 'scene_not_found' }` | Error toast, navigate back to project. |
| Project id not found | `404` `{ code: 'project_not_found' }` | Error toast, navigate to dashboard. |
| Server restart drops in-memory session | GET rehydrates from `scene.shot_plan_chat` if accepted; unsaved chat is lost | Same trade-off as Ideation today. |

**Cancel semantics.** Cancel is for backing out of an in-progress chat without committing. To keep this clean, the implementation should either (a) reuse DELETE only when no prior `shot_plan` exists on disk, since DELETE-with-nothing-saved is harmless and also evicts the in-memory session, or (b) add a small `POST .../shot-plan/evict` route that drops the in-memory session without touching disk. Pick one in the implementation plan; both are simple, and the choice is invisible to the user. The UI Cancel link returns the view to either the empty state (if no prior plan) or the Accepted state (Refine flow). Discard is the only path that intentionally erases a saved plan, and always uses DELETE.

## Testing strategy

Match existing patterns: `*.test.ts` next to source, integration tests in `apps/server/src/routes/*.test.ts`, e2e in `tests/e2e/`.

**Server unit tests** (`apps/server/src/services/shot-plan/index.test.ts`):
- Session lifecycle: create, hydrate from `scene.shot_plan_chat`, send message, evict.
- Prompt assembly: scene fields + project fields are present, source-doc filenames included.
- JSON parser: well-formed block → steps; malformed → empty; missing → empty; multiple blocks → first wins.
- Accept clears the in-memory session.
- LLM client mocked the same way Ideation mocks it.

**Server integration tests** (`apps/server/src/routes/shot-plan.test.ts`):
- Happy path for each route.
- 404 paths (unknown project / scene).
- 400 path (accept with empty proposed steps).
- DELETE clears both fields on the scene.
- Accept writes `shot_plan` and `shot_plan_chat` to `storyboard.yaml`.

**E2E** (`tests/e2e/shot-plan.spec.ts`):
- From a project with a scene: click Plan shots → send a canned message → assert proposed steps render → Accept → assert checklist appears.
- Open print view → assert numbered list renders with the right scene title.

**Web component tests**:
- Add for `ShotPlanSection.tsx` if the existing Vitest setup supports component tests (consistent with how Plan 09 made this judgment). Otherwise rely on the e2e for UI coverage.

## File manifest

**Create**
- `packages/shared/src/storyboard.ts` — extend `SceneSchema` (modify).
- `apps/server/src/services/shot-plan/index.ts`
- `apps/server/src/services/shot-plan/index.test.ts`
- `apps/server/src/routes/shot-plan.ts`
- `apps/server/src/routes/shot-plan.test.ts`
- `prompts/scene-shot-plan.md`
- `apps/web/src/components/ShotPlanSection.tsx`
- `apps/web/src/components/ShotPlanPrintView.tsx`
- `apps/web/src/lib/parse-json-block.ts` (extracted from Ideation)
- `tests/e2e/shot-plan.spec.ts`

**Modify**
- `apps/server/src/server.ts` — register `shot-plan` routes and inject `ShotPlanManager`.
- `apps/web/src/lib/api.ts` — add `shotPlanApi`.
- `apps/web/src/pages/ScenePage.tsx` — render `ShotPlanSection` above `RecordingUpload`.
- `apps/web/src/pages/Ideation.tsx` — replace inline JSON-block parsing with `parse-json-block.ts` import.
- `apps/web/src/components/StoryboardPreview.tsx` (or whichever component renders the scene list) — passive checklist glyph when `shot_plan` present.
- `apps/web/src/App.tsx` (or router config) — add the two print routes.

## Risks

- **Per-scene session sprawl in memory.** If a user opens chats on every scene in a 10-scene storyboard without accepting any, the manager holds 10 sessions. Each is small (transcript + proposed steps), but worth bounding. Mitigation: add an LRU cap of, say, 20 sessions across all scenes; evict oldest. Defer to the implementation plan whether to ship the LRU in v1 or leave as a known limitation.
- **LLM granularity drift.** The prompt asks for literal keystroke detail, but the model only knows what's in the scene description and source-doc filenames. Many first drafts will be too vague. The chat refinement loop is the mitigation — the user supplies missing specifics ("the URL is X", "use the install command from README.md") and the model rewrites. This is by design, not a bug; documented in the empty-state helper text so the user knows what to expect.
- **`shot_plan_chat` size.** Transcripts can grow long. They're persisted in `storyboard.yaml`, which is also where everything else lives. If a single scene's chat hits hundreds of turns the file gets noisy. Realistic ceiling for the use case is well under that. Defer concern; revisit if `storyboard.yaml` size becomes a problem.

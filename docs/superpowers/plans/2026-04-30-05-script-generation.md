# Plan 05 — Script Generation

**Goal:** Add AI-powered narration script generation for each scene. Users click "Generate Script" on the scene's Script tab, the system uses the scene description and recording metadata to produce an emotive narration script with style tags like `[warm]`, `[thoughtful]`. Scripts are editable inline and saved to `storyboard.yaml` under `scene.narration.script`.

**Architecture:** Builds on Plans 01–04. Adds a script generation service that calls the LLM with scene context, a route for generating/saving scripts, and updates the scene page Script tab from placeholder to functional editor with generate + save buttons.

**Tech Stack additions:** None. Uses existing LLM client, storyboard service, Fastify routes.

**Spec reference:** `docs/superpowers/specs/2026-04-29-vpa-phase1-design.md`, sections 2.3 (per-scene loop, script tab), 5.4 (scene page).

---

## Task 1: Script generation prompt

**Files:**
- Create: `prompts/narration-writer.md`

System prompt instructing the LLM to write a narration script with emotive tags based on scene description, recording metadata, and project context.

---

## Task 2: Script generation service

**Files:**
- Create: `apps/server/src/services/script/index.ts`
- Create: `apps/server/src/services/script/index.test.ts`
- Modify: `apps/server/src/services/llm/fake.ts` — add script generation response

Pure function: takes scene info + LLM client → returns script text.

---

## Task 3: Script routes

**Files:**
- Create: `apps/server/src/routes/scripts.ts`
- Create: `apps/server/src/routes/scripts.test.ts`
- Modify: `apps/server/src/server.ts`

Routes:
- `POST /api/projects/:id/scenes/:sceneId/script/generate` — generate script via LLM, save to storyboard
- `PUT /api/projects/:id/scenes/:sceneId/script` — save edited script to storyboard
- `GET /api/projects/:id/scenes/:sceneId/script` — get current script

---

## Task 4: Web API client + Script tab UI

**Files:**
- Modify: `apps/web/src/lib/api.ts` — add script API methods
- Modify: `apps/web/src/pages/ScenePage.tsx` — replace Script placeholder with editor

---

## Task 5: E2E test

**Files:**
- Create: `tests/e2e/script.spec.ts`

---

## Dependencies

```
Task 1 (prompt) ──► Task 2 (service) ──► Task 3 (routes) ──► Task 4 (UI) ──► Task 5 (E2E)
```

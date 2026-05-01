# Plan 07 — Lower Thirds

**Goal:** Add lower-third management for each scene. Users go to the Lower Thirds tab, click "Recommend" to get AI-suggested lower thirds based on the scene description, then edit title/subtitle/style/timing inline. Lower thirds are saved to `storyboard.yaml` under `scene.lower_thirds[]`. Rendering (Remotion/canvas overlay) is deferred to a later plan — this plan covers the data + UI layer.

**Architecture:** Builds on Plans 01–06. Adds a lower-thirds recommender service (LLM-based), routes for CRUD + recommend, and replaces the Lower Thirds tab placeholder with an interactive editor.

**Spec reference:** Sections 2.3 (per-scene loop, lower thirds tab), 5.4 (scene page LT pane).

---

## Task 1: Lower-thirds recommender prompt + service

- Create: `prompts/lower-third-recommender.md`
- Create: `apps/server/src/services/lower-thirds/index.ts`
- Create: `apps/server/src/services/lower-thirds/index.test.ts`
- Modify: `apps/server/src/services/llm/fake.ts` — add LT recommender response

## Task 2: Lower-thirds routes + tests

- Create: `apps/server/src/routes/lower-thirds.ts`
- Create: `apps/server/src/routes/lower-thirds.test.ts`
- Modify: `apps/server/src/server.ts`

## Task 3: Web API + Lower Thirds tab UI

- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/pages/ScenePage.tsx`

## Task 4: E2E test

- Create: `tests/e2e/lower-thirds.spec.ts`

## Dependencies

```
Task 1 (service) → Task 2 (routes) → Task 3 (UI) → Task 4 (E2E)
```

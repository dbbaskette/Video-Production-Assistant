# Plan 08 — Quality Review

**Goal:** Add a project-wide quality review. Users click "Run Quality Review" on the Overview page. The AI inspects the storyboard and emits a punch list of issues per scene: missing assets, narration length vs recording duration, lower-third copy problems, scene description clarity. Each item has a severity (info/warn/issue) and a link to the relevant scene. Results display on a Review page accessible from the sidebar.

**Architecture:** Builds on Plans 01–07. Adds a quality-review service (LLM-based), routes, a Review page, and updates the Overview page with a review button + status.

**Spec reference:** Sections 2.4 (quality review), 5.1 (sidebar with Review link).

---

## Task 1: Quality review prompt + service

- Create: `prompts/quality-review.md`
- Create: `apps/server/src/services/quality-review/index.ts`
- Create: `apps/server/src/services/quality-review/index.test.ts`
- Modify: `apps/server/src/services/llm/fake.ts` — add quality review response

## Task 2: Quality review routes + tests

- Create: `apps/server/src/routes/quality-review.ts`
- Create: `apps/server/src/routes/quality-review.test.ts`
- Modify: `apps/server/src/server.ts`

## Task 3: Review page + Overview updates

- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/pages/ReviewPage.tsx`
- Modify: `apps/web/src/pages/ProjectOverview.tsx` — add review button + status card
- Modify: `apps/web/src/App.tsx` — add review route
- Modify: `apps/web/src/components/ProjectSidebar.tsx` — add Review link

## Task 4: E2E test

- Create: `tests/e2e/quality-review.spec.ts`

## Dependencies

```
Task 1 (service) → Task 2 (routes) → Task 3 (UI) → Task 4 (E2E)
```

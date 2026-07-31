# Workflow Status and Render Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project progress trustworthy, prevent incomplete full renders, consolidate the overview, and replace the content-covering health rail with an accessible issues drawer.

**Architecture:** A shared Zod contract describes canonical workflow status. A server service computes steps, issues, preflight, and render freshness from project files. Every client surface consumes the same query. Successful renders and quality reviews store semantic fingerprints so existing output can be classified as current or stale.

**Tech Stack:** TypeScript, Zod, Fastify, React, TanStack Query, Vitest, Playwright, Node crypto/fs.

## Global Constraints

- Preserve stale output for playback and download.
- Optional script, narration, and lower-thirds work never blocks a full render.
- Recompute blockers inside the render POST route; the browser is not the authority.
- Exclude renderer-generated cache fields from fingerprints.
- Work in coherent end-to-end increments and test at milestone boundaries.

---

## Task 1: Define the canonical status contract

**Files:**
- Create: `packages/shared/src/workflow-status.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/workflow-status.test.ts`

- [ ] Define schemas for `WorkflowStepState`, semantic action keys, issues, render preflight, output freshness, and the complete response.
- [ ] Give issues stable IDs, severity, phase, optional scene identity, message, recommendation, and action key.
- [ ] Model counts explicitly so the overview and sidebar never infer totals independently.
- [ ] Export schemas and inferred TypeScript types from the shared package.
- [ ] Add schema tests for a complete response and rejection of malformed state/severity combinations.

## Task 2: Add stable fingerprints and manifests

**Files:**
- Create: `apps/server/src/services/workflow-status/fingerprint.ts`
- Create: `apps/server/src/services/workflow-status/render-manifest.ts`
- Test: `apps/server/src/services/workflow-status/fingerprint.test.ts`
- Modify: `apps/server/src/routes/render.ts`
- Modify: `apps/server/src/routes/quality-review.ts`

- [ ] Build a deterministic JSON normalizer and SHA-256 helper.
- [ ] Construct render input data from ordered scenes, source media metadata, narration, lower thirds, transitions, frame settings, music, brand assets, and effective render options.
- [ ] Exclude `overlay_render`, `frame_render`, review output, chat, and shot-plan prose.
- [ ] Write `renders/render-manifest.json` atomically only after a successful final render.
- [ ] Add a parallel review-input fingerprint when saving quality-review output.
- [ ] Cover stable derived-cache changes and meaningful upstream changes with unit tests.

## Task 3: Compute workflow state and enforce preflight

**Files:**
- Create: `apps/server/src/services/workflow-status/index.ts`
- Create: `apps/server/src/services/workflow-status/issues.ts`
- Create: `apps/server/src/routes/workflow-status.ts`
- Test: `apps/server/src/services/workflow-status/index.test.ts`
- Test: `apps/server/src/routes/workflow-status.test.ts`
- Modify: `apps/server/src/routes/render.ts`
- Modify: `apps/server/src/index.ts`

- [ ] Implement one preflight function that checks storyboard existence, scene count, each recording path/file/probe result, and active render jobs.
- [ ] Add option-aware warnings for partial narration, lower thirds, subtitles, missing brand assets, and quality-review state.
- [ ] Compute the ordered seven workflow steps and choose exactly one next action.
- [ ] Classify final output as missing, current, stale, or in progress using the manifest and current fingerprint.
- [ ] Classify legacy/corrupt manifests as stale with a useful issue instead of throwing.
- [ ] Serve `GET /api/projects/:id/workflow-status` and validate the response with the shared schema.
- [ ] Make `POST /render` return HTTP 409 `{ code: "render_blocked", blockers }` when the same preflight finds blockers.
- [ ] Add route tests for missing projects, partial recordings, complete projects, stale output, and render blocking.

## Task 4: Establish one client query

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/pipeline.ts`
- Modify: `apps/web/src/components/ProjectSidebar.tsx`
- Test: `apps/web/src/lib/pipeline.test.ts`

- [ ] Add typed workflow-status fetching and one reusable query-key helper.
- [ ] Map server action keys to client routes in one pure function.
- [ ] Replace independently derived sidebar progress with canonical step states and the `Next` marker.
- [ ] Invalidate workflow status after storyboard, recording, narration, lower-third, brand, review, and render mutations.
- [ ] Keep previous successful data during refetch so navigation does not flicker.

## Task 5: Consolidate the overview and issues UI

**Files:**
- Create: `apps/web/src/components/ProjectActionCard.tsx`
- Create: `apps/web/src/components/ProjectIssuesDrawer.tsx`
- Modify: `apps/web/src/pages/ProjectOverview.tsx`
- Modify: `apps/web/src/pages/ProjectWorkspace.tsx`
- Delete: `apps/web/src/components/HealthRail.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/e2e/project-workflow.spec.ts`

- [ ] Replace the pipeline and separate attention card with a compact card containing progress, next action, seven state markers, issue counts, and three priority issues.
- [ ] Add a header-level `Project issues` trigger that becomes `Project ready` when empty.
- [ ] Implement a right-side modal drawer with blockers first, phase grouping, deep links, Escape close, focus trap, and trigger focus restoration.
- [ ] Make the drawer full-width on narrow screens and ensure it never reserves or covers normal page content while closed.
- [ ] Remove every `HealthRail` import, render site, style, and test assumption.
- [ ] Add E2E assertions that overview and sidebar agree and that issue deep links work.

## Task 6: Add render readiness and freshness UX

**Files:**
- Create: `apps/web/src/components/RenderPreflight.tsx`
- Modify: `apps/web/src/pages/RenderPage.tsx`
- Modify: `apps/web/src/pages/ProjectOverview.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Test: `apps/web/e2e/render-preflight.spec.ts`

- [ ] Show ready-scene count, blockers, and warnings above render controls.
- [ ] Disable full-project render while blockers exist and link each blocker to its corrective scene/phase.
- [ ] Handle a server 409 race by rendering the returned blocker list immediately.
- [ ] Label mismatched or legacy output `Outdated`, keep play/download actions, and offer `Render again`.
- [ ] Refresh workflow status during active render jobs and after completion/failure.
- [ ] Cover blocked, ready, running, current, and stale states in E2E tests.

## Task 7: Verify and document

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-31-workflow-status-render-readiness-design.md` only if implementation details legitimately changed.

- [ ] Document the canonical states, stale-output behavior, and render-preflight rule.
- [ ] Run shared, server, and web unit tests once the end-to-end slice is complete.
- [ ] Run the relevant Playwright workflow and render tests.
- [ ] Run the full repository test, typecheck, and lint commands discovered from package scripts.
- [ ] Inspect `git diff --check`, review for duplicate status computation, and verify no bottom health rail remains.

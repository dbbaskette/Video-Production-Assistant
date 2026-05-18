# Plan 09 — Device Mockup Frames (Flat + Perspective)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render scenes inside a device mockup frame (laptop, phone, browser chrome, tablet) at flat or perspective-tilted angles, with a brand/transparent/custom background fill. Selectable at project default and per-scene override level. Closes [#25](https://github.com/dbbaskette/Video-Production-Assistant/issues/25).

**Architecture:** A new `services/frame/` module loads a `manifest.json` describing every shipped frame asset (PNG + transform metadata), exposes a `renderFramed(...)` step that wraps the scene's video in the chosen frame via ffmpeg (flat = scale + overlay; perspective = perspective filter + overlay), and slots into the existing render pipeline between lower-thirds and audio mux. Result is cached in a new `scene.frame_render` field analogous to `scene.overlay_render`. Storyboard defaults gain `frame_style` + `frame_background`; scenes gain optional `frame_style`/`frame_background` overrides. UI surfaces a thumbnail picker on the project render section and the per-scene render section. One real reference asset ships (`laptop-flat`) so the feature is end-to-end usable on day one; the remaining 7 frames are a content task tracked separately.

**Spec reference:** Issue #25 — full body at `/tmp/vpa-issue-4-device-mockups.md`.

**Risks:**
- ffmpeg's `perspective` filter expects destination corners; building the warp+overlay chain so the area outside the warped quad is fully transparent (not black) is the main implementation hazard. We mitigate by running the chain end-to-end against the reference asset in TDD before generalising.
- The `overlay_render` cache is keyed by lower-third content; adding a new `frame_render` cache means we now have a derivation chain (`recording → overlay → framed`). Invalidation on any upstream change must invalidate downstream. Handled by always re-running the frame pass when the upstream input mtime is newer than the cached frame output.
- Existing scenes shouldn't change behaviour. Default `frame_style` must be undefined for new and existing storyboards; render pipeline must be a no-op when `frame_style` is unset.

---

## File Structure

**Server (new):**
- `apps/server/assets/device-frames/manifest.json` — single source of truth for available frames.
- `apps/server/assets/device-frames/frames/laptop-flat.png` — one shipped reference frame (others tracked as content task).
- `apps/server/assets/device-frames/thumbnails/laptop-flat.png` — thumbnail of same.
- `apps/server/src/services/frame/manifest.ts` — manifest loader + validator (zod).
- `apps/server/src/services/frame/manifest.test.ts`
- `apps/server/src/services/frame/render.ts` — `renderFramed()` + filter-chain builders.
- `apps/server/src/services/frame/render.test.ts`
- `apps/server/src/routes/frames.ts` — `GET /api/frames` enumeration route.
- `apps/server/src/routes/frames.test.ts`

**Server (modify):**
- `apps/server/src/services/render/index.ts` — slot frame pass into per-scene render; honor scene-level + default `frame_style`/`frame_background`.
- `apps/server/src/services/render/scene-render.ts` — same for the per-scene render path.
- `apps/server/src/routes/storyboard.ts` (or equivalent — confirm during Task 5) — extend defaults update to accept `frame_style`/`frame_background`.
- `apps/server/src/routes/scene-render.ts` — accept per-invocation `frameStyle`/`frameBackground` overrides.
- `apps/server/src/server.ts` — register frames route.

**Shared (modify):**
- `packages/shared/src/storyboard.ts` — add `frame_style` + `frame_background` to `StoryboardDefaultsSchema` and `SceneSchema`.

**Web (new):**
- `apps/web/src/components/FrameStylePicker.tsx` — thumbnail grid grouped by family with flat/tilt toggle + background picker.
- `apps/web/src/components/FrameStylePicker.test.tsx` (if Vitest setup supports — otherwise drop).

**Web (modify):**
- `apps/web/src/lib/api.ts` — `framesApi.list()`, extend `RenderOptions` with `frameStyle` + `frameBackground`, extend `sceneRenderApi.start()` opts.
- `apps/web/src/pages/ProjectOverview.tsx` — render the picker in the render settings region; persist project default via storyboard-defaults route.
- `apps/web/src/components/SceneRenderSection.tsx` — render the picker for per-scene override; pass override into start mutation.

---

## Task 1: Manifest schema, loader, and one reference frame

**Files:**
- Create: `apps/server/assets/device-frames/manifest.json`
- Create: `apps/server/assets/device-frames/frames/laptop-flat.png` (placeholder is fine for tests — see step note)
- Create: `apps/server/assets/device-frames/thumbnails/laptop-flat.png`
- Create: `apps/server/src/services/frame/manifest.ts`
- Test: `apps/server/src/services/frame/manifest.test.ts`

**What it does:** A typed registry of frame assets keyed by `id`. Each entry declares its PNG path, thumbnail path, frame pixel size, and either a flat `inset` rectangle or a perspective `quad` of four corner points. Loaded once at startup, exposed as a typed `FrameManifest` interface.

**Manifest shape:**
```json
{
  "version": 1,
  "frames": [
    {
      "id": "laptop-flat",
      "family": "laptop",
      "variant": "flat",
      "displayName": "MacBook (flat)",
      "frame": "frames/laptop-flat.png",
      "thumbnail": "thumbnails/laptop-flat.png",
      "frameSize": { "w": 1920, "h": 1200 },
      "type": "flat",
      "inset": { "x": 80, "y": 80, "w": 1760, "h": 1100 }
    }
  ]
}
```

For perspective entries, `type: "perspective"` and `quad: { tl, tr, br, bl }` where each corner is `{ x, y }` in the frame PNG's coordinate space.

**Steps:**

- [ ] **Step 1: Write the failing test**

  Cover: valid flat entry parses, valid perspective entry parses, missing fields rejected, unknown frame id lookup returns undefined, manifest singleton caches across calls.

  Test should construct a temp directory with a hand-written `manifest.json` (no PNG required for parse tests) and assert the loader returns the parsed schema. Use the `mkdtemp` / `rm` pattern from `apps/server/src/services/overlay/render.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

  `npm run test -w @vpa/server -- frame/manifest.test.ts`. Expected: module not found.

- [ ] **Step 3: Implement the manifest loader**

  In `manifest.ts`:
  - Export a zod schema `FrameEntrySchema` discriminated on `type: 'flat' | 'perspective'`.
  - Export `loadFrameManifest(assetsDir: string): Promise<FrameManifest>` — reads `manifest.json`, validates with zod, returns parsed object.
  - Export `getFrame(manifest: FrameManifest, id: string): FrameEntry | undefined`.
  - Export `defaultAssetsDir()` returning the path to `apps/server/assets/device-frames` relative to the running module (use `import.meta.dirname` consistent with existing code in `server.ts` line 106).

- [ ] **Step 4: Run test to verify it passes**

  Same command. Expected: PASS.

- [ ] **Step 5: Add the reference manifest entry + placeholder PNGs**

  Write `manifest.json` with just the `laptop-flat` entry above. For the PNGs, the plan deliberately ships only metadata-validatable placeholders — a 1920×1200 transparent PNG with an opaque rectangle around the inset will do for v1. Real frames are a designer task tracked outside this plan. Note this in a `README.md` next to the manifest.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/server/assets/device-frames/ apps/server/src/services/frame/
  git commit -m "feat(frames): manifest schema + loader, ship laptop-flat reference"
  ```

---

## Task 2: Frame rendering service (flat)

**Files:**
- Create: `apps/server/src/services/frame/render.ts`
- Test: `apps/server/src/services/frame/render.test.ts`

**What it does:** `renderFramed({ inputVideo, frameEntry, backgroundColor, outputPath }) → Promise<void>` invokes ffmpeg to wrap an input video in the chosen frame and write the result. This task handles `type: 'flat'`; perspective is Task 3.

**Filter strategy for flat:**

```
[0:v]scale=INSET_W:INSET_H,format=yuva420p[scaled];
color=c=BG:s=FRAME_WxFRAME_H:d=DURATION,format=yuva420p[bg];
[bg][scaled]overlay=INSET_X:INSET_Y[under];
[under][1:v]overlay=0:0:format=auto[out]
```

The frame PNG is the second input (`-loop 1 -i frame.png`). `BG` resolves from `backgroundColor`: a hex string for solid, `0x00000000` for transparent (output container must be a format that supports alpha — for transparent we emit a webm/ProRes path; for solid/brand we stay mp4).

**Steps:**

- [ ] **Step 1: Write the failing test (flat)**

  Mock the ffmpeg runner the same way `overlay/render.test.ts` mocks via `createFakeOverlayRenderer`. Pattern: extract the ffmpeg invocation behind a function pointer and inject a fake in tests that records args.

  Assertions:
  - Filter complex contains `scale=1760:1100`.
  - Frame PNG is the second `-i` input.
  - Overlay coordinates match the inset (`overlay=80:80`).
  - Background `color=` filter uses the resolved color string.

- [ ] **Step 2: Run test to verify it fails**

  Expected: function not defined.

- [ ] **Step 3: Implement `renderFramed` flat path**

  Reuse `runFfmpeg` from `apps/server/src/services/render/index.ts` (already exported). Build the filter chain via a `buildFlatFilter(entry, bgColor)` helper so it's unit-testable without invoking ffmpeg.

  Resolve `bgColor`:
  - `'transparent'` → `0x00000000` *and* output container must be webm or mov (mp4 has no alpha). For v1, restrict transparent backgrounds to error out with a clear message; transparent-background renders ship as a follow-up. Document this in the function's docstring.
  - `'brand'` → look up `colors.primary` via `resolveLtColors()` from `apps/server/src/services/overlay/colors.ts` (or extract a thinner `resolveBrandPrimary()` if `resolveLtColors` is overkill here).
  - hex (e.g. `#1a1a1a`) → pass through unchanged.

- [ ] **Step 4: Run test to verify it passes**

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/server/src/services/frame/
  git commit -m "feat(frames): flat frame rendering via ffmpeg overlay"
  ```

---

## Task 3: Frame rendering service (perspective)

**Files:**
- Modify: `apps/server/src/services/frame/render.ts`
- Modify: `apps/server/src/services/frame/render.test.ts`

**Filter strategy for perspective:**

```
[0:v]scale=BB_W:BB_H,format=yuva420p,pad=FRAME_W:FRAME_H:PAD_X:PAD_Y:color=0x00000000[padded];
[padded]perspective=
  x0=TL_X:y0=TL_Y:
  x1=TR_X:y1=TR_Y:
  x2=BL_X:y2=BL_Y:
  x3=BR_X:y3=BR_Y:
  sense=destination:
  interpolation=linear[warped];
color=c=BG:s=FRAME_WxFRAME_H:d=DURATION,format=yuva420p[bg];
[bg][warped]overlay=0:0:format=auto[under];
[under][1:v]overlay=0:0:format=auto[out]
```

`BB_W`/`BB_H` is the bounding box of the quad (used to scale the input video to a sensible pre-warp size). `PAD_X`/`PAD_Y` is the offset of that bounding box inside the frame's full canvas so the perspective filter operates in frame-space coordinates.

**Steps:**

- [ ] **Step 1: Write the failing test (perspective)**

  Add a fixture perspective entry to the test manifest. Assertions:
  - Filter chain contains `perspective=` with the four destination corners matching the quad.
  - Pre-warp scale uses the quad's bounding-box dimensions.
  - Same background and final overlay structure as flat path.

- [ ] **Step 2: Run test to verify it fails**

  Expected: dispatch on `type === 'perspective'` not implemented.

- [ ] **Step 3: Implement perspective branch**

  Add `buildPerspectiveFilter(entry, bgColor)`. Compute bounding box from the four quad corners. Construct the perspective expression. Document the filter graph inline.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Smoke-render a perspective frame end-to-end (manual)**

  Add a temporary `laptop-tilt-right` entry to the manifest with a hand-picked quad (the placeholder PNG doesn't matter, only the geometry). Run a one-off integration test that actually shells out to ffmpeg against a 5-second sample video. Verify the output file exists and ffprobe reports the expected dimensions. **Do not commit the temp manifest entry** — remove before commit. The test itself can stay if it gates on a `VPA_RUN_FFMPEG_TESTS=1` env var so CI doesn't need ffmpeg.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/server/src/services/frame/
  git commit -m "feat(frames): perspective-tilted frame rendering"
  ```

---

## Task 4: Storyboard schema additions

**Files:**
- Modify: `packages/shared/src/storyboard.ts`

**Steps:**

- [ ] **Step 1: Extend `StoryboardDefaultsSchema`**

  Add:
  ```ts
  frame_style: z.string().optional(),
  frame_background: z
    .union([
      z.literal('brand'),
      z.literal('transparent'),
      z.string().regex(/^#[0-9a-fA-F]{6}$/),
    ])
    .optional(),
  ```

- [ ] **Step 2: Extend `SceneSchema`**

  Same two optional fields. Scene-level wins over defaults; both unset means no frame.

- [ ] **Step 3: Build shared package**

  ```bash
  npm run build -w @vpa/shared
  ```

  Expected: PASS.

- [ ] **Step 4: Run server typecheck to confirm no regressions**

  ```bash
  npm run typecheck -w @vpa/server
  ```

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/shared/
  git commit -m "feat(frames): add frame_style + frame_background to storyboard schema"
  ```

---

## Task 5: Integrate frame pass into the render pipeline

**Files:**
- Modify: `apps/server/src/services/render/index.ts`
- Modify: `apps/server/src/services/render/scene-render.ts`

**Where it slots in:** Frame compositing is a third optional stage between lower-thirds (`overlay_render`) and the audio mux. The video that enters `muxScene` becomes either `frame_render` (if set), or `overlay_render`, or the raw recording — picked by most-derived-existing.

**New helper:** `resolveSceneFrame(scene, defaults): { frameStyle?: string; frameBackground?: ... }` — applies the override chain (scene → defaults).

**Caching:** New scene field `frame_render` set the same way `overlay_render` is set today (via `updateScene()` and `saveStoryboard()`). Skip the frame pass if the cached frame output is newer than its upstream (`overlay_render` or recording mtime).

**Steps:**

- [ ] **Step 1: Write the failing test**

  Extend `apps/server/src/services/render/scene-render.test.ts` (create if missing) to assert: a scene with `frame_style` set produces a `frame_render` and the muxed `combined.mp4` is derived from the framed video, not the bare overlay. Use the fake ffmpeg runner pattern.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Wire `renderFramed` into the per-scene mux path**

  In `services/render/index.ts` `muxScene()`: before picking `videoSrc`, if `resolveSceneFrame()` returns a frame style and the manifest knows about it, run `renderFramed()` into `<projectPath>/renders/.tmp/<sceneId>-framed.mp4`. Use that as `videoSrc`. Persist the relative path on `scene.frame_render` via `updateScene()` so future renders skip the pass if the upstream is unchanged.

  In `services/render/scene-render.ts`, do the equivalent before producing `combined.mp4`.

  Extend `SceneSchema` extension already covers persistence; `prepareNarrationAudio` is untouched. Audio mux semantics (`replace`/`mix`) remain identical.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

  ```bash
  git add apps/server/src/services/render/
  git commit -m "feat(frames): apply chosen frame in per-scene render"
  ```

---

## Task 6: Frames enumeration route + tests

**Files:**
- Create: `apps/server/src/routes/frames.ts`
- Create: `apps/server/src/routes/frames.test.ts`
- Modify: `apps/server/src/server.ts`

**What it does:** `GET /api/frames` returns the manifest entries (without `frame`/`thumbnail` paths leaking — the API exposes derived URLs instead, e.g. `/api/frames/:id/thumbnail`). Two endpoints:

- `GET /api/frames` — array of `{ id, family, variant, displayName, type, thumbnailUrl }`.
- `GET /api/frames/:id/thumbnail` — streams the PNG.

**Steps:**

- [ ] **Step 1: Write the failing test**

  Spin up Fastify with the route registered and a mock manifest. Assert:
  - `GET /api/frames` returns the seeded entries.
  - `GET /api/frames/laptop-flat/thumbnail` returns 200 with `image/png`.
  - `GET /api/frames/nonsense/thumbnail` returns 404 with code `not_found`.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement routes**

  Follow the pattern from `routes/voice-clone.ts` for streaming a file with `createReadStream`. Use the manifest loader from Task 1.

- [ ] **Step 4: Register in `server.ts`**

  Add the import + `await app.register(...)` call alongside the others.

- [ ] **Step 5: Run test to verify it passes**

- [ ] **Step 6: Commit**

  ```bash
  git add apps/server/src/routes/frames.ts apps/server/src/routes/frames.test.ts apps/server/src/server.ts
  git commit -m "feat(frames): GET /api/frames enumeration + thumbnails"
  ```

---

## Task 7: Storyboard defaults route + scene override route

**Files:**
- Modify: `apps/server/src/routes/storyboard.ts` (locate during execution — the storyboard service has a routes module already)
- Possibly create: `apps/server/src/routes/storyboard.test.ts` if not present
- Modify: `apps/server/src/routes/scene-render.ts` to accept per-invocation `frameStyle`/`frameBackground` overrides

**What it does:** Lets the UI persist project-level defaults and per-scene overrides.

- `PUT /api/projects/:id/storyboard/defaults` — accept `{ frame_style?, frame_background? }`. Existing route may already update `defaults`; extend its schema if so.
- `PATCH /api/projects/:id/scenes/:sceneId/frame` — accept `{ frame_style?: string | null, frame_background?: string | null }`. `null` clears the override. Updates the scene via `updateScene()` + `saveStoryboard()` and invalidates `scene.frame_render` if present (delete the cached file so the next render rebuilds).

**Steps:**

- [ ] **Step 1: Confirm storyboard routes layout**

  Run `grep -rn "PUT.*storyboard\|defaults\b" apps/server/src/routes` to find the existing endpoint.

- [ ] **Step 2: Write the failing test for defaults update**

  Cover: valid payload writes to `storyboard.yaml`, invalid `frame_background` (not brand/transparent/hex) rejected with 400.

- [ ] **Step 3: Implement defaults update**

- [ ] **Step 4: Write the failing test for scene override**

  Cover: setting an override persists, sending `null` clears the override, an invalid frame id returns 400.

- [ ] **Step 5: Implement scene override + cache invalidation**

  After persisting, if the scene previously had `frame_render`, delete the file at that path (best-effort, ignore ENOENT) and clear the field.

- [ ] **Step 6: Run tests**

- [ ] **Step 7: Commit**

  ```bash
  git add apps/server/src/routes/
  git commit -m "feat(frames): defaults + per-scene override routes with cache busting"
  ```

---

## Task 8: Web API helpers

**Files:**
- Modify: `apps/web/src/lib/api.ts`

**Steps:**

- [ ] **Step 1: Add `framesApi`**

  ```ts
  export interface FrameInfo {
    id: string;
    family: string;
    variant: string;
    displayName: string;
    type: 'flat' | 'perspective';
    thumbnailUrl: string;  // absolute URL
  }
  export const framesApi = {
    async list(): Promise<FrameInfo[]> {
      return request<FrameInfo[]>('GET', '/api/frames');
    },
  };
  ```

- [ ] **Step 2: Extend `RenderOptions` and `sceneRenderApi.start()`**

  Add `frameStyle?: string | null` and `frameBackground?: 'brand' | 'transparent' | string | null` to both option types so a caller can override at render-time. The defaults flow remains: server falls back to scene → defaults if not provided.

- [ ] **Step 3: Add `storyboardApi.updateDefaults()`**

  Wraps `PUT /api/projects/:id/storyboard/defaults` with `{ frame_style?, frame_background? }`.

- [ ] **Step 4: Add `sceneApi.setFrame()`** (or extend an existing scene-patch helper)

  Wraps `PATCH /api/projects/:id/scenes/:sceneId/frame`.

- [ ] **Step 5: Run typecheck**

  ```bash
  npm run typecheck -w @vpa/web
  ```

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/web/src/lib/api.ts
  git commit -m "feat(frames): client api helpers for frames + defaults + scene override"
  ```

---

## Task 9: `<FrameStylePicker>` component

**Files:**
- Create: `apps/web/src/components/FrameStylePicker.tsx`

**What it does:** A presentational picker:

```
┌──────────────────────────────────────────────────────────┐
│  Frame style                                             │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                         │
│  │None │ │Laptop│ │Phone │ │Browser│                     │
│  └─────┘ └─────┘ └─────┘ └─────┘                         │
│                                                          │
│  Variant: [flat ▾]   ← appears when family ≠ None        │
│                                                          │
│  Background: ● brand   ○ transparent   ○ #1a1a1a [picker]│
└──────────────────────────────────────────────────────────┘
```

Props:
```ts
{
  value: { frameStyle?: string | null; frameBackground?: ... };
  onChange: (next: { frameStyle?: string | null; frameBackground?: ... }) => void;
  frames: FrameInfo[];           // from framesApi.list()
}
```

The picker groups frames by `family`. Selecting a family shows its variants (`flat` / `tilt-*`). Picking a variant sets `frameStyle = <id>`. Picking "None" sets `frameStyle = null`.

**Steps:**

- [ ] **Step 1: Build the component**

  Use existing styling tokens (`var(--bg-elev)`, `var(--accent)`, etc.) and the pattern from `BrandPicker.tsx` for the family thumbnails. No internal state — fully controlled.

- [ ] **Step 2: Render it in isolation via a temporary test route**

  Add a throwaway `/dev/frames` page mounted in `App.tsx` while developing so you can visually verify thumbnails render and family/variant toggling behaves. Remove before commit.

- [ ] **Step 3: Commit**

  ```bash
  git add apps/web/src/components/FrameStylePicker.tsx
  git commit -m "feat(frames): FrameStylePicker component"
  ```

---

## Task 10: Wire the picker into the project render section + per-scene render

**Files:**
- Modify: `apps/web/src/pages/ProjectOverview.tsx`
- Modify: `apps/web/src/components/SceneRenderSection.tsx`

**Steps:**

- [ ] **Step 1: ProjectOverview — picker for project default**

  In the render settings region (find the existing `audioMode` select around line 363), add the `FrameStylePicker` bound to `storyboard.defaults.frame_style` / `frame_background`. Save via `storyboardApi.updateDefaults()` on change. Invalidate the `storyboard` query on success.

- [ ] **Step 2: SceneRenderSection — per-scene override**

  Below the audio mode select, add a small "Frame override" affordance. Default: inherits from project (show a quiet label like "uses project default: MacBook (flat)"). Clicking "Override" exposes the same `FrameStylePicker`. Save via `sceneApi.setFrame()`. A "Reset to project default" link clears the override (sends `null`).

- [ ] **Step 3: Manual verification**

  Start the dev server, render a scene with `laptop-flat` selected, confirm the rendered `combined.mp4` shows the recording inside the frame inset. Render again with the picker cleared, confirm output reverts to the unframed scene.

- [ ] **Step 4: Commit**

  ```bash
  git add apps/web/src/pages/ProjectOverview.tsx apps/web/src/components/SceneRenderSection.tsx
  git commit -m "feat(frames): expose frame picker in project + per-scene render UI"
  ```

---

## Task 11: README + content-asset follow-up note

**Files:**
- Create: `apps/server/assets/device-frames/README.md`

**What it says:**
- How the manifest works (link to the schema).
- That v1 ships only `laptop-flat` as a real asset; other 7 device families × variants are tracked as a content-design task in a separate issue (file a follow-up issue at this step and reference its URL).
- How to add a new frame: drop the PNG + thumbnail under the appropriate subdir, append an entry to `manifest.json`, restart the server.

**Steps:**

- [ ] **Step 1: Write the README**

- [ ] **Step 2: File the follow-up content issue**

  Use `gh issue create` with a title like "Ship remaining device-frame assets (iPhone, Android, browser-chrome, tablet + perspective variants)" and reference back to #25 + this plan.

- [ ] **Step 3: Reference the follow-up issue number in the README**

- [ ] **Step 4: Commit**

  ```bash
  git add apps/server/assets/device-frames/README.md
  git commit -m "docs(frames): README + follow-up content issue link"
  ```

---

## Task 12: End-to-end verification

- [ ] **Step 1: Full build + typecheck**

  ```bash
  npm run typecheck && npm run build -w @vpa/server && npm run build -w @vpa/web
  ```

- [ ] **Step 2: Full server test suite**

  ```bash
  npm test -w @vpa/server
  ```

  Expected: all green, including the new frame tests.

- [ ] **Step 3: Manual end-to-end smoke**

  Run dev server. On an existing project with at least one scene + recording:
  1. Pick `laptop-flat` as project default in render settings. Run project render. Verify output shows the recording inside the frame.
  2. Override one scene to "no frame" via Scene Render Section. Re-render that scene. Verify it's unframed.
  3. Set background to a custom hex. Verify the area outside the inset matches.
  4. Confirm storyboard.yaml on disk has the new `defaults.frame_style` / `defaults.frame_background` and the scene's override.

- [ ] **Step 4: Commit any fixups + push the branch**

  ```bash
  git push origin claude/kind-babbage-7f6e63
  ```

---

## Self-review checklist (do this after writing all tasks above)

- [ ] **Spec coverage:** every acceptance criterion in #25 maps to at least one task.
  - "4 device families ship" → Task 11 follow-up issue (engineering plan ships 1 reference; content task delivers the rest).
  - "Every device family ships both flat and at least one perspective variant" → Task 11 follow-up; render code (Tasks 2 + 3) supports both.
  - "Per-scene picker honored at render time; project default applies when scene unset" → Tasks 5, 7, 10.
  - "Perspective warping uses precomputed transform metadata" → Tasks 1, 3.
  - "Aspect ratios that don't match a frame fall back to letterboxing inside the frame, not stretch" → Need to add: explicit letterboxing test in Task 2.
  - "Frame metadata (URL bar text for browser chrome) is editable per scene" → Not covered. **Defer to Task 11 follow-up** since no browser-chrome frame ships in v1, and document the gap.
  - "Brand color drives background fill when frame applied" → Task 2 (resolveLtColors integration).

- [ ] **Placeholder scan:** no "TBD", "TODO", "add validation", "implement appropriately". Filter chains are spelled out, file paths are exact.

- [ ] **Type consistency:** `frameStyle` (web/API) vs `frame_style` (storyboard YAML / shared schema) is the existing snake-vs-camel pattern in the codebase (e.g. `audioMode` API → `audio_mode` is *not* used; defaults already store `voice_profile` snake-cased while the API uses camelCase). Confirm both forms appear in the right tasks and there's a mapping at the route layer.

- [ ] **Dependency order:**
  ```
  T1 (manifest) → T2 (flat render) → T3 (persp render) → T4 (schema)
                                                       → T5 (pipeline integration)
                  → T6 (enum route) → T7 (defaults + override routes)
                                                       → T8 (web api)
                                                       → T9 (picker)
                                                       → T10 (wire UI)
                                                       → T11 (docs + follow-up)
                                                       → T12 (verify)
  ```

---

## Execution

Two options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks. Best for this plan because the render-pipeline integration (Task 5) and perspective filter (Task 3) are the riskiest and benefit from a clean subagent context to verify each independently.

**2. Inline Execution** — Execute tasks in this session with checkpoints. Lower overhead, faster, but Task 3 will burn context with ffmpeg iteration.

Pick one to proceed.

# Brand Library & design.md Generation — Design Spec

**Date**: 2026-04-30
**Status**: Draft (post-brainstorm)
**Predecessor**: `2026-04-29-vpa-phase1-design.md` (Phase 1 design)
**Builds on**: `2026-04-29-01-foundation-and-project-store.md` (Plan 01)

## 1. Summary

Add a **Brand Library** to the Video Production Assistant. From the dashboard, users
upload brand documents (PDF, markdown, URL, free text, or an existing `design.md`) and
the system extracts brand information using an LLM, producing a `design.md` file in the
[Google Labs design.md format](https://github.com/google-labs-code/design.md) extended
with a `vpa:` namespace for video-specific fields. Brands can be applied to projects,
downloaded as portable `design.md` files, and forked for project-specific
customization.

`design.md` is the canonical brand storage format in this system — not an export
artifact. The download capability gives users a portable file to share or import into
other design.md-aware tools.

## 2. Goals and Non-goals

### Goals

- Bring the dashboard a Brand Library, peer to the Project list, where users create,
  edit, fork, and apply brands.
- Generate a complete, valid `design.md` (vanilla schema + `vpa:` extensions) from
  uploaded source documents using a two-step LLM pipeline with a human review gate.
- Use [Microsoft MarkItDown](https://github.com/microsoft/markitdown) as the primary
  document → markdown extractor, with native Node fallbacks (`pdf-parse`, `cheerio +
  @mozilla/readability`) when MarkItDown isn't installed.
- Track which brand version each project last saw (`applied_version`) and surface a
  non-blocking "new version available" notification on subsequent brand updates.
- Support fork-on-edit as the **only** way to fully insulate a project from upstream
  brand changes. (Without forking, projects always read the current brand content —
  the version field exists for change detection, not version locking.)
- Allow one brand to be marked as the default; auto-apply to new projects.

### Non-goals (deferred to v2)

- Image inputs (palette extraction from logo PNG, OCR of color-palette screenshots).
- Figma file or DTCG token JSON imports.
- Multi-brand projects (co-branded videos with two logos).
- Bundled starter-brand marketplace beyond what the user creates.
- Multi-lingual source documents (v1 prompts assume English brand guidelines).
- Live propagation of brand changes to already-rendered downstream artifacts (lower-
  thirds, etc.). The next per-scene action picks up the new tokens.

## 3. User Flows

### 3.1 Create a brand

1. Dashboard → **Brands** section → **+ New Brand** button.
2. Wizard step 1 — **Identify**: enter name; slug auto-derived (`Tanzu` → `tanzu`),
   editable.
3. Wizard step 2 — **Sources**: drop zone (PDF, MD, existing `design.md`), URL field,
   free-text textarea. Multiple sources allowed in one run. Each appears in a
   removable list.
4. Wizard step 3 — **Extract**: click *Extract*. Server enqueues a `brand.extract` job
   and the wizard streams progress over SSE: *Persisting sources… → Parsing PDF
   (MarkItDown)… → Scraping URL… → Extracting tokens (LLM)…*. Cancellable.
5. Wizard step 4 — **Review** (two-pane): structured form on the left (color pickers,
   font fields, voice/tone textarea, lower-third template selector); live preview on
   the right with **Visual** and **Markdown** tabs. User edits as needed.
6. Wizard step 5 — **Generate**: click *Generate design.md*. Server runs the second LLM
   pass to write the prose body, assembles front-matter + body, validates, writes to
   `brands/<slug>/design.md` atomically, lands the user on the Brand Detail page.

### 3.2 Apply a brand to a project

- In the New/Edit Project flow, the Brand Picker is a typeahead dropdown listing all
  brands. Each option shows a colored swatch + name. **None** is a valid choice (project
  ships unbranded). The default brand (if set) is pre-selected.
- On selection, the project records `brand.id` (slug) and `brand.applied_version`
  (the brand's `version` field at pick time, used solely to detect future updates) in
  `project.yaml`.

### 3.3 Customize a brand for a project (fork-on-edit)

- From a project's brand panel, **Customize for this project** auto-creates a fork of
  the current brand named `<brand> · <project>` (slug `<brand>--<project-slug>`),
  switches the project to the fork, and lands the user on the fork's Brand Detail page
  for editing. The original brand is untouched.

### 3.4 Update a brand

- From Brand Detail, the user can edit tokens (returns to the review-form UI),
  re-generate from cached `extracted-text.md`, edit the raw markdown directly (power-
  user mode), or upload/replace logo assets.
- Any change that modifies `design.md` content increments the brand's `version`
  integer. Asset-only changes (uploading or replacing a logo file at the same path)
  do not bump version on their own. Adding a new asset path that's then referenced in
  `vpa.logo` does, because that mutates `design.md`.
- Projects whose `applied_version` is now behind see a non-blocking banner on the
  project detail page: *"Tanzu has a newer version (4). [Apply] [Dismiss]"*. The
  banner does not affect what content the project reads — content is always read live
  from `brands/<id>/design.md`. The banner only invites the user to mark the new
  version as seen.

### 3.5 Set the default brand

- From Brand Detail, a labeled toggle: *"Default brand — auto-applied to new projects
  unless overridden"*. Switching it on demotes whatever was previously default. The
  default brand shows a ⭐ pill in the dashboard's Brands list.

### 3.6 Download `design.md`

- From Brand Detail, **Download design.md** streams the file as `<slug>-design.md`. The
  file is the canonical on-disk content; no transformation.

### 3.7 Delete a brand

- If used by ≥1 project (matched on `brand.id`), the delete dialog lists those
  projects and requires the user to either re-target each to a different brand (or
  None) or cancel. No silent orphaning. If the brand is the default, deletion clears
  `default_brand_id`.

## 4. Data Model

### 4.1 File layout

```
brands/
└── <slug>/
    ├── design.md                  # canonical: YAML front matter + markdown body
    ├── parent.json                # present on forks: {"forked_from": "...", "forked_at": "..."}
    └── assets/
        ├── logo-primary.svg       # uploaded logos (paths referenced in vpa.logo)
        ├── logo-mono.png
        └── source-docs/
            ├── <original-filename>.pdf      # preserved upload originals (auditable)
            ├── <original-filename>.md
            ├── sources.json                  # {urls: [...], free_text: "..."}
            └── extracted-text.md             # MarkItDown output, cached for re-generation

apps/server/.vpa/brands.json       # global brand registry
```

### 4.2 Registry: `apps/server/.vpa/brands.json`

```json
{
  "default_brand_id": "tanzu",
  "brands": [
    {
      "id": "tanzu",
      "name": "Tanzu",
      "version": 3,
      "created": "2026-04-30T14:22:11Z",
      "updated": "2026-04-30T15:01:05Z",
      "forked_from": null
    }
  ]
}
```

Single-default invariant: at most one brand has `default_brand_id` pointing to it.
Setting a new default atomically replaces the previous value.

### 4.3 `design.md` shape (extended schema)

YAML front matter — standard Google fields plus a `vpa:` namespace. Standard fields are
unchanged from the [reference spec](https://github.com/google-labs-code/design.md);
extension fields are namespaced under `vpa:` so any strict design.md tool ignores them
without breaking.

```yaml
name: Tanzu
version: 3
description: Cloud-native developer brand
colors:
  primary: "#0091DA"
  accent: "#1B365D"
  surface: "#FFFFFF"
  on_surface: "#1A1C1E"
typography:
  heading: { family: "Inter", weights: [600, 700] }
  body:    { family: "Inter", weights: [400, 500] }
rounded: { sm: 4, md: 8, lg: 16 }
spacing: { unit: 8, scale: [4, 8, 16, 24, 32, 48] }
components: {}

vpa:
  voice:
    tone: "Confident, technical, optimistic"
    avoid: ["jargon", "hyperbole"]
  audio:
    music_mood: "uplifting-corporate"
    sonic_logo: null
  logo:
    primary: "assets/logo-primary.svg"
    mono:    "assets/logo-mono.png"
    safe_zone_ratio: 0.25
  lower_thirds:
    template: "bar-left-accent"
    bg: "{colors.primary}"
    fg: "{colors.on_surface}"
  taglines:
    - "Build cloud-native, faster"
```

The markdown body follows the Google section order — Overview, Colors, Typography,
Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts — followed by VPA
sections: Voice & Tone, Audio, Logo Usage. Each section is prose written by LLM call
#2 and is intended to be read by humans and by downstream LLM-driven agents (narration,
lower-thirds copy generation).

### 4.4 Project linkage

`project.yaml` adds:

```yaml
brand:
  id: "tanzu"            # slug; null if unbranded
  applied_version: 3     # brand's version field as last seen by this project
```

The server always reads `brands/<id>/design.md` directly when resolving a project's
brand — there is no version-gated read. The `applied_version` field exists only to
power the update banner: when `current_brand.version > project.brand.applied_version`,
the banner shows. Clicking *Apply* sets `applied_version = current_brand.version`.
**To truly insulate a project from upstream brand changes, fork the brand.**

### 4.5 Forks

Forks are first-class entries in `brands.json`. The `forked_from` field on the
registry entry and `parent.json` on disk record lineage. The UI renders a small "🔗
fork of <parent>" badge but forks are not segregated into a separate section — they
appear in the same Brands list.

### 4.6 zod schemas (in `packages/shared`)

- `DesignMd` — full parsed design.md (front matter + markdown body)
- `DesignMdFrontMatter` — YAML front matter only (Google fields + `vpa` extension)
- `VpaExtensions` — the `vpa:` sub-tree
- `BrandRegistry` — `brands.json` shape with the single-default invariant
- `BrandRegistryEntry` — one row in `brands[]`
- `BrandWithDoc` — registry entry joined with parsed design.md (for detail responses)

Validation runs on every write and on every read of disk content. Reads of
malformed design.md surface a structured error in the UI rather than silently
returning partial data.

## 5. UI Specification

### 5.1 Dashboard (extended)

Layout: Stacked sections, projects above brands.

```
┌─────────────────────────────────────────────────┐
│ VPA                                             │
├─────────────────────────────────────────────────┤
│ PROJECTS                          [+ New]       │
│   📹 Q4 Launch Demo                            │
│   📹 Customer Story · Acme                     │
│   📹 Tech Talk · Kubernetes                    │
│                                                 │
│ ─────────────────────────────────────────────── │
│ BRANDS                            [+ New]       │
│   🎨 Tanzu  ⭐                                  │
│   🎨 Heritage                                   │
│   🎨 Acme · Q4 Launch  🔗                      │
└─────────────────────────────────────────────────┘
```

- Each brand card shows a small color swatch (the `colors.primary` value), the brand
  name, ⭐ if default, and 🔗 if it's a fork.
- Empty state: "No brands yet. Create your first brand to apply consistent visual
  identity across video projects."

### 5.2 New Brand Wizard

- Path: `/brands/new`
- Five logical steps but rendered as a single scrolling page with sticky action bar
  (forward navigation reveals the next section; back is always available).
- File drops accept `.pdf`, `.md`, `.markdown`, `.txt`, `.yaml`, `.yml`. Existing
  `design.md` files are detected by content (presence of YAML front matter with `name`
  field) and pre-fill the review form rather than running LLM extraction.
- URL field validates as well-formed HTTP/HTTPS only.
- Free-text textarea with no upper limit but a soft warning over 10k chars (LLM
  context window concern).
- Cancel from any step returns to dashboard; the partially-created brand directory
  (if it was already created in step 4) is cleaned up.

### 5.3 Two-pane Review screen

- Left pane (form):
  - Identity: name (read-only after step 1 — slug determined), description
  - Colors: grid of color swatches + hex inputs (primary, accent, surface, on_surface,
    plus any others LLM extracted)
  - Typography: heading family, body family, weights (chip selector)
  - Spacing: base unit (px), scale array (chip-style editor)
  - Rounded: sm/md/lg sliders
  - Voice & Tone: textarea
  - Audio: music mood select, sonic logo file path (optional)
  - Logo: upload zones for primary and mono variants
  - Lower-thirds: template select (`bar-left-accent`, `centered-fade`, `minimal-line`),
    bg/fg color references
  - Taglines: editable list
- Right pane (preview):
  - **Visual** tab: color palette swatches, type sample with real brand text, mock
    lower-third using current colors and template
  - **Markdown** tab: live-rendered design.md with YAML front matter and prose body;
    syntax-highlighted. Updates as form changes (front matter only — prose is
    placeholder until the second LLM pass runs).
- Sticky action bar: **Generate design.md** (primary), **Cancel**, contrast warnings
  count (clickable to scroll to first violation).

### 5.4 Brand Detail page

- Path: `/brands/:slug`
- Header: brand name, fork badge, ⭐ default toggle, version number, "Updated 2 days
  ago".
- Tabs: **Overview**, **Tokens**, **Markdown**, **Assets**, **Used By**.
  - Overview: large color palette, type sample, current logo, voice quote
  - Tokens: searchable table of every token in the design.md
  - Markdown: read-only syntax-highlighted view with **Edit** button (opens raw
    markdown editor — power-user mode; saves bump version)
  - Assets: drag-drop upload zone for logos, list of source documents with download
    links
  - Used By: list of projects using this brand (matched on `brand.id`), click to navigate
- Action buttons: **Download design.md** • **Edit tokens** (re-opens review form) •
  **Regenerate** (re-runs LLM pipeline using cached `extracted-text.md`) • **Fork** •
  **Delete**

### 5.5 Project Brand Picker

- Inline component in `/projects/new` and `/projects/:id` settings.
- Typeahead dropdown; each option = swatch + name + ⭐ (if default) + 🔗 (if fork).
- "None" option always available.
- Below the picker: "Customize for this project" link (visible only when a brand is
  selected) — triggers fork-on-edit.

### 5.6 Brand-update notification

- When a brand bumps its `version`, projects whose `applied_version` is now behind
  show a banner on their project detail page: *"Tanzu was updated to v4. [Apply]
  [Dismiss]"*.
- **Apply**: sets the project's `applied_version` to the current brand version.
  Hides the banner. No re-rendering of downstream artifacts is triggered — they pick
  up new tokens on the next per-scene action.
- **Dismiss**: hides the banner for this project until the brand version changes
  again. The project still reads the current brand content (the banner is purely
  informational; it does not control what's loaded).
- If the user wants the project to be unaffected by upstream brand changes, the
  correct action is **Fork** — surfaced separately on the project's brand panel.

## 6. Backend Services

### 6.1 New service modules under `apps/server/src/services/`

```
brand/
  index.ts                   # public API
  store.ts                   # brands.json + filesystem ops; single-default invariant
  fork.ts                    # fork-on-edit logic
  validate.ts                # zod-based validation, contrast checks
  download.ts                # serve design.md for file download

document-extract/
  index.ts                   # extract(input) → { markdown, sourceMeta }
  markitdown.ts              # subprocess wrapper (primary)
  fallback-pdf.ts            # pdf-parse fallback
  fallback-url.ts            # cheerio + @mozilla/readability fallback
  detect.ts                  # check MarkItDown availability at startup, cache result

brand-generation/
  index.ts                   # orchestrator
  extract-tokens.ts          # LLM call #1: text → structured tokens (JSON)
  write-rationale.ts         # LLM call #2: tokens → prose body
  assemble.ts                # combine front matter + body → design.md text
```

### 6.2 Reused infrastructure

- **LLM Service** (pluggable, from Phase 1 spec): default Gemini 2.5 Flash; swappable
  in Settings.
- **Job Queue + SSE** (from Phase 1 spec): brand creation runs as `brand.extract` job
  with progress events.
- **Atomic file utils** and **path utils** from Plan 01.
- **Shared zod schemas** in `packages/shared`, extended with the design.md types.

### 6.3 Generation pipeline (the `brand.extract` job)

1. **Persist sources**: write uploaded files to
   `brands/<slug>/assets/source-docs/`; store URL list and free-text in `sources.json`
   in that directory. Emit SSE event `persisted`.
2. **Extract**: for each source, call `document-extract.extract()` → concatenate to
   `assets/source-docs/extracted-text.md`. Emit SSE events `extracting:<source>` and
   `extracted:<source>` with byte counts.
3. **LLM call #1** (`extract-tokens.ts`): prompt LLM with extracted text + design.md
   schema reference + few-shot example; expect strict JSON; validate against
   `DesignMdFrontMatter` zod schema. Retry once on invalid JSON with a stricter
   prompt; surface error if both attempts fail. Emit SSE event `tokens-ready` with
   the JSON payload.
4. UI lands on the two-pane review screen; user edits. *Job suspends here, waiting
   for the user's Generate command via a new POST.*
5. **LLM call #2** (`write-rationale.ts`): prompt LLM with finalized tokens; produces
   the markdown body covering all standard sections plus VPA sections. Emit SSE event
   `rationale-ready`.
6. **Assemble** (`assemble.ts`): combine YAML front matter (from finalized tokens) +
   markdown body. Run validation post-assembly (parse round-trip, contrast checks).
7. **Atomic write** to `brands/<slug>/design.md`. Update `brands.json` registry. Emit
   SSE event `done` with the brand slug.

### 6.4 Editable prompts (existing pattern from Phase 1 spec)

- `prompts/brand-extract-tokens.md` — system prompt for LLM call #1. Includes the
  design.md schema as reference and one few-shot example (input excerpt → JSON
  output).
- `prompts/brand-write-rationale.md` — system prompt for LLM call #2. Instructs the
  model to produce each Google-spec section in order followed by VPA sections, using
  the brand voice/tone described in the tokens.
- Both are editable on disk; no rebuild required; reads happen at job start time.

### 6.5 MarkItDown integration

- **Detection**: at server startup, `document-extract/detect.ts` runs `markitdown
  --version`; result cached. Settings page shows status: "MarkItDown installed
  (v0.x.y)" or "MarkItDown not installed — using fallback extractors. [Install
  instructions]".
- **Invocation**: subprocess via `node:child_process`. Inputs piped or referenced by
  path; output captured to memory then written to cache.
- **Timeout**: 60s per source.
- **Fallbacks** when MarkItDown is unavailable:
  - `.pdf` → `pdf-parse`
  - URLs → `fetch` + `cheerio` + `@mozilla/readability`
  - `.md`, `.markdown`, `.txt` → read directly (no extraction needed)
  - `.docx`, `.pptx`, `.xlsx` → unsupported in fallback path; surface a per-source
    error suggesting MarkItDown installation

### 6.6 API surface (Fastify, under `/api`)

| Method | Path                              | Purpose                                                         |
|--------|-----------------------------------|-----------------------------------------------------------------|
| GET    | `/brands`                         | List brands (registry rows)                                     |
| POST   | `/brands`                         | Create — multipart: files + JSON body. Returns `{job_id, slug}` |
| POST   | `/brands/:slug/generate`          | Resume the extract job after review; body = finalized tokens    |
| GET    | `/brands/:slug`                   | Brand detail (registry + parsed design.md)                      |
| PUT    | `/brands/:slug`                   | Update tokens, markdown, or `is_default` flag                   |
| POST   | `/brands/:slug/fork`              | Create fork; body `{name}` (defaults to `<parent> · copy`)      |
| POST   | `/brands/:slug/regenerate`        | Re-run LLM with cached extracted-text. Returns `{job_id}`       |
| POST   | `/brands/:slug/assets`            | Upload logo files                                               |
| DELETE | `/brands/:slug/assets/:file`      | Remove asset                                                    |
| GET    | `/brands/:slug/download`          | Stream design.md as `<slug>-design.md`                          |
| DELETE | `/brands/:slug`                   | Delete brand. 409 if any project references it and `force=true` not passed |
| GET    | `/jobs/:id/stream`                | SSE progress (existing)                                         |

## 7. Failure Modes

| Failure                                | Response                                                                                                                  |
|----------------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| MarkItDown missing                     | Detect at startup; use fallback path; UI shows soft hint                                                                  |
| MarkItDown subprocess fails / times out| Fall back to native extractor for that source; log and surface partial extraction warning                                 |
| URL fetch fails / robots-blocked       | Skip that source with per-source error; other sources continue                                                            |
| LLM returns invalid JSON               | Log raw response; retry once with stricter prompt; on second failure surface error with raw text shown for manual entry  |
| LLM schema validation fails            | Highlight bad fields in review form; allow user to fix manually                                                            |
| Contrast ratio violations              | Soft warnings only; non-blocking; review screen shows count and lets user click through to first violation                |
| File write fails                       | Atomic write means no partial state; surface error; job moves to `failed` state with retry button                          |
| PDF over 50MB                          | Reject upload at the route layer with a clear size-limit error                                                            |
| URL content over 200k chars            | Truncate to 200k with a warning before LLM call (cost + context window protection)                                        |
| Free-text input over 10k chars         | Soft warning in UI, but accepted; LLM gets the full text                                                                  |
| Brand delete with referencing projects | 409 unless `force=true`; UI presents re-targeting dialog                                                                  |
| Default brand deleted                  | `default_brand_id` cleared; dashboard banner shows "No default brand set"                                                  |
| Concurrent `is_default` flips          | Single-default invariant enforced via atomic write of `brands.json`                                                       |

## 8. Validation Rules

- `name`: 1–80 chars, trimmed
- `slug`: lowercase, alphanumeric + hyphens; max 80 chars; unique across brands
- Color values: 6- or 8-digit hex (`#RRGGBB` or `#RRGGBBAA`)
- Typography family: non-empty string; weights: array of 100..900 step 100
- Spacing unit: positive integer; scale: ascending positive integers
- Rounded values: non-negative integers
- `vpa.logo.primary` / `mono`: must reference an existing file in `assets/`
- Contrast checks (warnings, not errors): `colors.on_surface` on `colors.surface`, and
  `vpa.lower_thirds.fg` on `vpa.lower_thirds.bg` (resolved via the `{colors.x}`
  reference syntax). Target WCAG AA (4.5:1 for body, 3:1 for large).

## 9. Decisions Made (Confirmed in Brainstorm)

- **Scope**: Global brand library + per-project overrides via fork-on-edit.
- **Inputs in v1**: PDF, markdown, URL, existing design.md, free-text. (Images and
  Figma deferred.)
- **Generation flow**: Extract → Review (form + live preview) → Save (LLM writes
  rationale).
- **Schema**: Extended (vanilla Google design.md plus `vpa:` namespace).
- **Dashboard placement**: Stacked Sections (Projects above, Brands below).
- **Override mechanism**: Fork-on-edit (the only way to fully insulate a project).
  Projects also record the brand's `version` at pick/apply time as `applied_version`,
  used solely to surface a non-blocking notification when the brand has been updated
  since.
- **Document extraction**: MarkItDown (subprocess) primary, native Node libraries as
  fallback. Python 3.10+ documented as soft prerequisite for best results.
- **Contrast violations**: soft warnings, not blocking.
- **Seed brand**: none. First run is empty; user creates their first brand. Default
  brand is a separate concept set via toggle on Brand Detail.

## 10. Implementation Notes (Pointers, Not Plan)

- This spec is intended to feed an implementation plan written via the writing-plans
  skill. The plan will sequence:
  1. Shared zod schemas + types
  2. document-extract service (with MarkItDown detection + fallbacks)
  3. brand store (registry + filesystem)
  4. brand-generation pipeline (LLM calls + assembly)
  5. Brand routes (REST API)
  6. Job-queue integration for `brand.extract`
  7. Web UI: dashboard Brands section
  8. Web UI: New Brand wizard
  9. Web UI: Brand Detail page
  10. Web UI: Project Brand Picker integration
  11. End-to-end Playwright test
- Plan 01 (Foundation & Project Store) must land first; this work depends on the
  project store, atomic file utils, and the LLM/Job-Queue/SSE infrastructure.

## 11. Open Items Not Resolved Here

- Exact prompt text for `brand-extract-tokens.md` and `brand-write-rationale.md` —
  drafted in the implementation plan with at least one few-shot example each.
- Specific component breakdown of the React wizard and Brand Detail page.
- Test fixture sample documents (a small fake brand PDF, a stub brand website).
- Whether the Markdown power-user editor uses CodeMirror or a simpler textarea (lean:
  CodeMirror, decided in plan).

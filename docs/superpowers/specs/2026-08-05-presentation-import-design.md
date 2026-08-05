# Presentation-to-Video Import Design

## Summary

VPA will accept a PDF presentation and create one storyboard scene for every
page. Each imported page becomes a high-resolution slide image and a short,
silent still-video source so it can participate in the existing recording-first
render pipeline. Users can then edit or generate narration, synthesize or record
voiceover, add transitions and overlays, mix slide scenes with recordings, and
render the storyboard as a normal VPA video.

The first release accepts PDF only. PDF is the canonical presentation format
because page order and rendered appearance are stable, each page maps directly
to one scene, and no cloud authorization or office-suite installation is
required. Future PowerPoint and Google Slides adapters will convert to this
same canonical PDF pipeline rather than introduce separate scene behavior.

Presentation import has two failure boundaries. Deterministic asset and scene
creation is atomic from the user's perspective: either every page is added or
none is. Optional AI narration runs only after the scenes exist. Gemini analyzes
the slide images, and the independently configured writing model turns those
briefs into spoken scripts. AI failure never removes a successfully imported
deck or overwrites user edits.

## Goals

- Accept a local PDF when creating a project or editing an existing storyboard.
- Create one ordered `slide` scene per PDF page.
- Preserve every page's visible appearance without cropping.
- Generate a renderable visual source for every imported scene.
- Draft narration from both visible slide content and extracted text.
- Use Gemini for visual understanding and the configured writing model for the
  final narration.
- Show useful progress and clean, retryable failure states.
- Reuse the existing narration, transition, overlay, and final-render workflows.
- Retain enough presentation provenance to identify, retry, or remove an import.
- Leave a straightforward path to PowerPoint and Google Slides support.

## Non-Goals

- Importing PowerPoint or Google Slides directly in the first release.
- Preserving slide animations, presentation transitions, embedded audio, or
  embedded video.
- Reconstructing editable slide objects from a PDF.
- Synchronizing scenes after the source deck changes.
- Reading speaker notes from PDF files.
- Rendering a live presentation player during final video export.
- Replacing the existing video-oriented scene render pipeline.
- Automatically overwriting scenes when a revised deck is imported.

## Format Decision and Future Adapters

### PDF first

PDF is the only accepted MVP input. A library-backed PDF renderer reads the
document, extracts per-page text where available, and rasterizes each page at a
bounded output size. The implementation must not require LibreOffice,
PowerPoint, Google authentication, or a separate system-level PDF utility.

### PowerPoint later

A `.pptx` adapter may later extract slide order, speaker notes, and document
metadata from PresentationML, then convert the deck to PDF for visual rendering.
The converted PDF enters the same importer. Speaker notes can become preferred
writing context without changing the scene or asset model.

The conversion layer must explicitly report missing fonts and rendering
differences. VPA must not imply pixel-perfect PowerPoint fidelity when the deck
is rendered by a different office engine.

### Google Slides later

A Google Slides adapter may later use Google Drive authorization to export a
presentation as PDF, then feed the exported bytes into the same importer. The
Google file ID and revision ID can be recorded as source provenance, but the MVP
does not attempt live synchronization.

## User Experience

### New-project flow

The New Project dialog gains a third starting mode: **Presentation**. It appears
alongside the existing ideation and recording choices.

After choosing a PDF, the dialog shows:

- Original file name.
- File size and page count.
- Thumbnails for the first few pages.
- The number of scenes that will be created.
- **Generate draft narration** enabled by default.
- A clear note that animations and embedded media become static slides.

This preview is a non-authoritative, browser-local PDF preflight so the user can
review the deck before creating the project. The server independently validates
the uploaded bytes and may reject a file the preview opened if it violates
server limits or safety checks.

The project is created first, then the presentation import is started. A failed
import leaves an empty, usable project with a retry action; it never leaves a
partially populated storyboard.

### Existing-project flow

The Storyboard page gains **Add presentation** near the existing add-scene and
recording actions. Imported scenes are appended after the current final scene.
Users can reorder them normally after import.

The confirmation surface states that importing a revised deck creates new
scenes. It does not replace scenes from an earlier import.

### Progress

The UI displays one presentation job with four plain-language stages:

1. **Uploading**
2. **Processing slides**
3. **Creating scenes**
4. **Drafting narration**

The deterministic stages show completed pages out of total pages. The narration
stage shows analyzed and scripted pages independently. The storyboard becomes
available as soon as scene creation commits; narration continues in the
background.

Closing the dialog does not cancel processing. Returning to the project shows
the current job state. A failed deterministic import offers **Try again**. A
failed or partially completed AI stage offers **Retry narration** and preserves
successful page results.

## Generated Scene Behavior

Every page creates one scene with:

- `type: slide`.
- A stable, project-unique scene ID generated by the server.
- A name derived from the first plausible page heading, falling back to
  `Slide N`.
- A description derived from bounded extracted page text, or a neutral
  placeholder for image-only pages until visual analysis completes.
- A short silent H.264 still-video source.
- Presentation provenance containing the import ID, one-based page number,
  total page count, and relative page-image path.
- Empty narration or a generated draft, depending on the import option and AI
  result.

Scene order exactly matches PDF page order. Imported scenes behave like normal
storyboard scenes: users may reorder them, delete them individually, edit their
names and descriptions, change transitions, add lower thirds, generate or
record narration, and mix them with other scene types.

AI completion must not overwrite a scene name, description, or narration that
the user edited while generation was running. Before applying an AI result, the
job compares the field to the import-time value. A changed field is preserved,
and the generated result is stored as a reviewable draft rather than being
silently discarded over the user's work.

## Slide Layout and Duration

Pages are normalized into a 1920x1080 output frame at 30 fps. The original page
is scaled with `contain`, centered, and never cropped. Unused frame space uses a
subtle blurred and darkened copy of the page behind the sharp contained page.
This preserves the complete slide while avoiding harsh black bars for 4:3,
portrait, and unusual page sizes.

The importer creates a short still-video source for compatibility; that source
duration is not the final narrated-scene duration. Presentation provenance adds
an editable `hold_duration_sec`, defaulting to five seconds.

At render time, a presentation scene's effective duration is:

1. The prepared narration-audio duration when narration is included.
2. Otherwise, `hold_duration_sec`.

The renderer holds the final video frame or trims as needed to match that exact
duration. Duration-aware UI and validation use the same helper rather than the
physical source clip's probe duration. This prevents a short generated clip
from truncating narration and prevents an arbitrary source duration from
creating a long silent tail.

## Persistence Model

### Project layout

Each import receives an opaque UUID and owns one project-relative directory:

```text
presentations/<presentation-id>/
  manifest.json
  source.pdf
  pages/
    page-0001.png
  clips/
    page-0001.mp4
  analysis/
    page-0001.json
  drafts/
    page-0001.json
```

Temporary work is written under a project-local staging directory that is not
referenced by the storyboard. Paths persisted in project files are always
relative and server-generated. Original upload names are display metadata only
and never become path components.

Import job summaries live separately under `presentation-jobs/` so upload,
processing, and failure state can be polled before a final presentation bundle
exists. A job record contains only bounded status/progress data and a reference
to its server-owned staging directory. A successfully committed job points to
the final manifest. A failed validation job removes the uploaded bytes; a valid
PDF that encountered an operational processing failure may be retained in
staging for explicit retry.

### Presentation manifest

`manifest.json` is a versioned server-owned record containing:

- Schema version and presentation ID.
- Sanitized display name, source SHA-256, byte size, and import timestamp.
- Page count and raster output dimensions.
- Import status and bounded public error information.
- Whether narration drafting was requested.
- One ordered page record containing page number, page image, still clip, scene
  ID after commit, extracted-text availability, AI status, and any unapplied
  draft path.
- Resolved Gemini and writing model entry/model IDs for completed AI work.

The manifest does not contain API keys, absolute local paths, raw provider
responses, or unbounded document text.

### Storyboard additions

`RecordingSchema.source_kind` gains `presentation`.

`SceneSchema` gains optional `presentation_source` metadata:

```yaml
presentation_source:
  presentation_id: 3ea80df1-...
  page_number: 1
  page_count: 18
  image: presentations/3ea80df1-.../pages/page-0001.png
  hold_duration_sec: 5
```

The scene's existing `recording.source` points to its generated MP4 under the
same presentation directory. Render code continues to require a recording
source; downstream consumers can identify generated slide media from
`source_kind` and `presentation_source`.

## Deterministic Import Pipeline

1. Stream the multipart upload into a bounded staging file while hashing it.
2. Validate content as PDF rather than trusting the file extension or MIME
   header.
3. Reject encrypted, malformed, oversized, or over-page-limit documents with a
   stable public error code.
4. Read page count and per-page dimensions.
5. Extract bounded text separately for each page where possible.
6. Rasterize each page into the normalized 1920x1080 PNG layout.
7. Generate the short H.264/yuv420p still-video source with FFmpeg.
8. Build and validate all proposed scenes and the final presentation manifest
   without mutating the storyboard.
9. Acquire the existing project mutation lock.
10. Re-read the current storyboard, assign collision-free scene IDs, move the
    completed staged directory into `presentations/<id>`, append all scenes,
    and save the storyboard atomically.
11. Mark the manifest ready and enqueue optional AI work.

No scene becomes visible before every page asset and proposed scene validates.
A validation failure removes the entire staging directory. If the uploaded PDF
was valid but an operational page-processing step failed, the job may retain
only the bounded source PDF for an explicit processing retry; all partial page
assets are removed first. If the process exits after the final directory move
but before storyboard commit, the unreferenced manifest remains recoverable
garbage and is removed by startup or retry cleanup. It is never presented as an
imported deck.

Project mutation locking is required because a user may edit or reorder scenes
while a presentation is processing. The final append operates on the latest
storyboard rather than the version loaded at upload time.

## AI Narration Pipeline

AI narration is post-import, optional, and retryable. It has two explicit model
responsibilities.

### Slide understanding

Gemini receives the normalized slide image plus bounded extracted page text and
returns a versioned `PresentationSlideBrief` containing:

- A concise visual summary.
- A detected title.
- Ordered key points.
- Relevant charts, diagrams, screenshots, and relationships.
- Visible quantitative claims that should be spoken accurately.
- Ambiguous or unreadable content that the writer should not invent.

The output is schema-validated and stored under the presentation's `analysis`
directory. Freshness depends on the page-image hash, extracted-text hash,
Gemini entry and concrete model IDs, schema version, and prompt version.

The MVP reuses the model assigned to the existing persisted
`video-understanding` role because it is already the project's configured
Gemini visual model. The user-facing assignment label broadens from **Watch and
analyze video** to **Understand visual media**; the persisted key remains
unchanged for compatibility. The model resolver exposes an image-analysis path
that enforces Gemini and does not require the writing provider to receive media.

If the Gemini assignment is missing, incompatible, or unavailable, the slides
remain imported and narration status becomes **Needs visual model**. There is no
silent text-only or alternate-provider fallback.

### Script writing

The configured `writing` model receives only text:

- Project objective and audience.
- Slide number and title.
- Extracted page text.
- The validated Gemini slide brief.
- Neighboring slide titles and brief summaries for continuity.
- A direction to explain the slide naturally rather than read every bullet.

The writer returns one concise monologue draft for the scene. It must not invent
claims Gemini marked uncertain. The draft is validated and saved through the
normal narration mutation path so existing script history, dialog conversion,
TTS, and render behavior continue to work.

Processing uses bounded concurrency and records progress per page. Retries
reuse fresh slide briefs and regenerate only missing or failed scripts. A
writing-model failure never invalidates a successful Gemini brief.

## API Shape

The server adds presentation-scoped endpoints:

- `POST /api/projects/:id/presentations` — accept multipart PDF plus
  `generate_narration`; return `202` with presentation/job ID.
- `GET /api/projects/:id/presentations` — list imports and current progress.
- `GET /api/projects/:id/presentations/:presentationId` — return one bounded
  manifest/progress view.
- `POST /api/projects/:id/presentations/:presentationId/retry-import` — rerun a
  failed deterministic job only when a validated staged source is still
  available; otherwise require a new upload.
- `POST /api/projects/:id/presentations/:presentationId/retry-narration` — retry
  failed or missing AI work without recreating scenes.
- `DELETE /api/projects/:id/presentations/:presentationId` — confirm and remove
  remaining scenes from that import plus owned assets.

Project creation remains separate. The new-project client creates the project,
then calls the same presentation endpoint used by an existing project. This
avoids a second importer and leaves the empty project usable when upload or
processing fails.

Polling is sufficient for the first release and matches other VPA job flows.
Responses expose stable error codes and bounded user-facing messages, never
absolute paths or provider diagnostics.

## Deletion and Re-Import Semantics

Deleting one imported scene removes only that scene from the storyboard. Its
page assets stay in the presentation bundle until the whole import is removed,
which keeps provenance and retry behavior simple.

**Remove imported deck** lists how many remaining scenes will be deleted and
requires confirmation. The server removes those scenes atomically, invalidates
their derived render assets, and then removes the owned presentation directory.
If asset cleanup fails after the storyboard mutation, the user-visible removal
still succeeds and cleanup is retried; orphaned files are safer than restoring
deleted scenes unexpectedly.

Uploading the same or a changed PDF always creates a new presentation ID and a
new set of scenes. VPA may warn that the source hash was previously imported,
but it does not deduplicate or overwrite because users may have intentionally
edited the earlier scenes.

## Validation and Safety

Default limits are 100 MB and 200 pages, configurable by the local VPA server.
The upload stream, extracted page text, rendered dimensions, AI context, and
provider outputs are all bounded. PDF page dimensions are normalized before
raster allocation so hostile page sizes cannot request an unbounded canvas.

The importer rejects:

- Non-PDF content disguised by an extension or MIME type.
- Password-protected or encrypted PDFs.
- Malformed documents that cannot produce a reliable page count.
- Files or page counts above configured limits.
- Any generated path that escapes the project root.

Provider errors and parsing diagnostics are logged privately with presentation
and page IDs. Public errors identify the failed stage and an actionable next
step without document contents, credentials, raw model output, or local paths.

## Error Handling

- Upload interruption: discard the incomplete staging file; no job or scene is
  committed.
- PDF validation failure: keep the project usable and show the exact supported
  format or limit.
- Any page render or clip failure: fail the deterministic job, remove staging,
  and add no scenes.
- Storyboard conflict: acquire the project mutation lock and append against the
  latest validated storyboard.
- Gemini failure: retain all scenes, mark affected pages retryable, and preserve
  any completed briefs.
- Writing failure: retain scenes and briefs, mark only missing scripts retryable.
- User edit during AI work: preserve the user value and do not apply stale AI
  output over it.
- Server restart: recover persisted job and manifest state, resume AI work or
  offer retry, and remove staging directories that have no matching job.
- Final render failure: retain presentation assets and use the existing render
  diagnostics; the import itself remains valid.

## Testing

### Shared schema tests

- `presentation` recording provenance compatibility.
- Presentation source page bounds, duration bounds, and relative-path checks.
- Versioned presentation manifest and slide-brief validation.
- Model-routing compatibility after broadening the visual-media label/resolver.

### Import service tests

- One PDF page produces one ordered proposed scene.
- Heading extraction and `Slide N` fallback.
- Selectable-text and image-only documents.
- 16:9, 4:3, portrait, rotated, and unusual page sizes.
- Normalized output never crops the source page.
- Encrypted, malformed, oversized, and excessive-page documents.
- Failure on any page commits no scenes.
- Concurrent storyboard edits are retained when scenes append.
- Startup cleanup removes only unreferenced abandoned imports.

### AI service tests

- Gemini receives image plus bounded page text.
- Writing receives the validated brief but no image bytes or remote media URI.
- Missing visual or writing assignments fail cleanly without model fallback.
- Fresh brief reuse and invalidation by source/model/prompt changes.
- Partial page failure and targeted retry.
- User-edited fields are never overwritten by late AI results.
- Image-only decks can produce drafts through Gemini.

### Route tests

- Multipart validation and project ownership.
- Job creation, progress retrieval, restart recovery, and bounded errors.
- Retry narration touches only missing or failed pages.
- Individual scene deletion versus confirmed whole-deck removal.
- Re-import creates independent provenance and scenes.

### Render and UI tests

- Slide duration follows narration audio when present.
- Slide duration follows editable hold duration without narration.
- Lower thirds, transitions, subtitles, music, and mixed scene types render.
- New-project Presentation mode and existing-project Add presentation flow.
- Thumbnails, page counts, progress, dialog-close behavior, and retry states.
- Final rendered video contains every imported slide in storyboard order.

Automated tests use small generated PDF fixtures. One manual acceptance test
imports a representative real deck containing 16:9, 4:3, portrait, chart,
screenshot, and image-only slides, generates narration with Gemini plus the
configured writer, and renders the complete video.

## Rollout Order

1. Shared presentation, provenance, and slide-brief schemas.
2. Project paths, bounded upload, PDF validation, text extraction, and page
   rasterization.
3. Still-video generation, effective slide duration, and render integration.
4. Atomic presentation import service and persisted job/manifest recovery.
5. Presentation routes and delete/retry behavior.
6. New-project and storyboard upload/progress UX.
7. Gemini slide understanding through the existing visual-model assignment.
8. Writing-model narration generation with edit-preservation checks.
9. Full render coverage and real-deck acceptance test.
10. Evaluate PowerPoint conversion and notes only after the PDF workflow proves
    reliable.

## Success Criteria

- A valid PDF creates exactly one ordered slide scene per page without manual
  asset preparation.
- A failure during deterministic processing creates zero scenes.
- Imported slides can be narrated and rendered with the existing VPA workflow.
- Final slide duration matches narration instead of the generated clip length.
- Gemini performs visual interpretation while the selected writing model authors
  scripts.
- Model failures preserve imported media and provide a clear retry path.
- User edits made during background generation are never overwritten.
- The design can accept future PPTX or Google Slides adapters by producing a PDF
  and optional per-page notes, without changing imported scene semantics.

# Task-Based Model Routing Design

## Summary

VPA currently has one globally active text model. Most features receive that one
`LlmClient`, while video-grounded features bypass the text abstraction and call
Gemini directly. A video-grounded action is only available when Gemini happens
to be the globally active model. This forces users to switch models before and
after a workflow and prevents VPA from using Gemini for video understanding and
Claude or Codex for writing in the same operation.

VPA will replace the single active-model concept with task-based model routing.
Users will assign one configured model to each stable task role, set global
defaults once, and optionally override those assignments per project. Video-
grounded writing will become a two-stage workflow: Gemini watches the video and
produces a structured brief; the assigned writing model turns that brief into
the final script or other prose.

There are no automatic fallback models. An unavailable, unassigned, or
incompatible model stops the requested AI operation with a clear remediation
message. Media upload and attachment remain local operations and are never
rolled back because an AI model is unavailable.

## Goals

- Use a Gemini model for every operation that sends video to a model or derives
  visual timing from video.
- Use an independently configured writing model, such as Claude or Codex, for
  scripts and editorial work.
- Preserve a separate assignment for general non-video analysis.
- Support global defaults and optional per-project overrides.
- Make the resolved model visible near important AI actions.
- Reuse one validated video-understanding artifact instead of repeatedly
  uploading the same recording for each downstream feature.
- Fail clearly without silently substituting metadata-only analysis or another
  model.

## Non-Goals

- Arbitrary user-authored pipeline graphs.
- Backup-model chains or automatic provider fallback.
- Per-click model pickers on every feature screen.
- Sending video to providers other than Gemini in the first version.
- Moving API credentials into project files.
- Making AI availability a prerequisite for storing or attaching media.

## Task Roles

The first version defines three stable roles:

### `video-understanding`

This role handles any model call that receives video or produces observations
grounded in video time. It includes upload-time scene analysis, visual change
detection, timestamped scene segments, pacing cues, script cues, and candidate
lower-third moments. The selected entry must be a ready Gemini configuration
with an API key and video capability.

### `writing`

This role handles authored language: initial narration scripts, video-grounded
scripts, rewrites, tightening, polishing, monologue-to-dialog conversion,
ideation copy, shot-plan prose, and lower-third wording. Claude API, Claude Code,
Codex CLI, Gemini, OpenAI-compatible, and fake test entries are text-capable.
Multiple roles may point to the same model entry.

### `general`

This role handles non-video analytical work that is not primarily authored
copy, including quality review, source-document summarization, brand token
extraction, brand rationale analysis, and other utility classification. It may
point to the same entry as `writing`, but remains independently assignable so a
cheaper or local model can be used later without changing feature code.

New roles may be added by extending a central role definition. Feature code
must request a role rather than inspect provider names or the global registry.

## Model Catalog and Capabilities

Configured provider entries remain reusable model definitions. The catalog
supports the existing providers plus Codex CLI when the current Codex provider
work is integrated:

- `gemini`
- `anthropic`
- `claude-code`
- `codex-cli`
- `openai-compat`
- `fake`

Capabilities are derived from the provider implementation and are not editable
free-form flags. Every supported entry has text capability. In the first
version, only Gemini entries have video capability. API responses expose these
capabilities and readiness, but never expose API keys.

The persisted global model file advances to a versioned shape:

```json
{
  "version": 2,
  "models": [],
  "assignments": {
    "video-understanding": "gemini-model-entry-id",
    "writing": "claude-or-codex-entry-id",
    "general": "general-entry-id"
  }
}
```

Assignment values are model entry IDs. A role may be absent when it has not
been configured. Credentials remain only in the local global model catalog.

Project-level overrides are stored in `project.yaml` as model entry IDs:

```yaml
model_routing:
  video_understanding: gemini-model-entry-id
  writing: claude-or-codex-entry-id
  general: general-entry-id
```

An omitted project field means “use the global assignment.” Project files do
not duplicate endpoints or credentials.

## Routing Service

A `ModelRouter` becomes the only feature-facing model selection mechanism. It
accepts a task role and optional project overrides, then resolves in this
order:

1. Project assignment for the requested role.
2. Global assignment for the requested role.
3. Referenced model entry existence.
4. Provider readiness and required capability.
5. Retry-wrapped client construction.

The result includes the client, entry ID, provider, model ID, display label,
and capabilities. Video resolution additionally returns the Gemini credentials
needed by the dedicated Files API adapter. Feature routes do not call
`registry.getActive()`, compare `provider === 'gemini'`, or hold one shared
`SwappableLlm`.

Resolution failures use stable error codes:

- `model_assignment_missing`
- `model_assignment_invalid`
- `model_capability_mismatch`
- `model_unavailable`

Messages name the role and direct the user to either project or global model
settings. They do not include credentials or raw provider responses.

There is exactly one assigned model per role. The router never selects another
entry automatically after a resolution or provider failure.

## Video Understanding Artifact

One `VideoUnderstandingService` owns Gemini Files API upload, processing,
generation, validation, cleanup, and local artifact reuse. Its output is a
versioned `VideoUnderstandingBrief` stored under:

`analysis/video/<scene-id>.json`

The brief contains:

- Schema and prompt versions.
- Scene ID.
- Source path, SHA-256 fingerprint, duration, width, and height.
- Model entry ID, provider, and concrete model ID.
- Creation timestamp.
- A concise visual summary.
- Timestamped segments with stable segment IDs, start/end seconds, screen-change
  descriptions, visible labels, and relevant on-screen terms.
- Pacing and narration cues tied to segment IDs.
- Candidate lower-third moments tied to segment IDs.

The shared schema validates all timestamps as finite, non-negative, ordered,
and within the probed video duration. Text fields and collection sizes are
bounded. The local brief may contain visible on-screen text, so it stays inside
the project and is never included in public error messages.

A brief is current only when all of the following match:

- Source-video SHA-256 fingerprint.
- Assigned video model entry ID and concrete model ID.
- Brief schema version.
- Video-understanding prompt version.

Changing the recording, changing the video assignment, or changing the prompt
marks the brief stale. A video-grounded operation regenerates a missing or stale
brief before continuing. Concurrent requests for the same scene and freshness
key share one in-flight analysis rather than uploading duplicate Gemini files.

Gemini remote files are deleted in a best-effort `finally` path after the brief
has been generated. Failure to delete is logged privately and does not discard
a successfully validated local brief.

## Workflow Data Flows

### Upload and recording attachment

Media ingestion, probing, hashing, and attachment complete locally first. If
the upload workflow requests automatic scene understanding, VPA resolves the
`video-understanding` role and generates the brief. A Gemini failure does not
delete or detach the uploaded video. The UI reports that the video is attached
and that analysis needs attention.

### Scene reanalysis

Reanalysis resolves `video-understanding`, ensures a current brief, and derives
the scene name, description, and type from that brief. If video grounding is
requested, there is no metadata-only fallback. Dry-run review and explicit
apply behavior remain unchanged.

### Video-grounded script generation

1. Resolve the project’s `video-understanding` and `writing` roles.
2. Ensure a current video brief through Gemini.
3. Build writing context from scene intent, project objective and audience,
   source documents, duration target, and the structured brief.
4. Ask the writing model for the final narration script.
5. Persist only after the writing response validates.
6. Generate the dialog variant with the same writing assignment.

The writing provider never receives video bytes or a Gemini remote file URI.
Text-only script generation skips the video role and uses `writing` directly.

### Lower thirds

Gemini supplies timestamped candidate moments in the brief. The writing model
creates concise title/subtitle copy anchored to selected segment IDs. VPA maps
those IDs back to validated times and rejects out-of-range or reordered output.
Text-only lower-third generation remains available only when the user does not
request video grounding.

### Other text features

Script editing features, ideation, and shot-plan prose resolve `writing`.
Quality review, source-document summarization, brand extraction, and utility
analysis resolve `general`. A helper called inside a feature receives that
feature’s already-resolved client or explicitly requests its own role; it never
uses a hidden global client.

Any future feature that sends an uploaded video to a model must resolve
`video-understanding` and use `VideoUnderstandingService`.

## Settings and Project UX

The global Settings page retains a model library for adding, editing, testing,
and removing provider configurations. Model cards show provider, concrete model
ID, readiness, and `Text` or `Video` capability badges. The current `Active`
badge and `Use This` action are removed.

A new **Model assignments** section presents three plain-language rows:

- **Watch and analyze video**
- **Write and refine content**
- **General analysis**

Each row contains one selector and a readiness summary. The video selector only
offers compatible Gemini entries. Unassigned and invalid states remain visible
instead of silently choosing a model.

Project Overview gains an **AI models** section with the same three rows. Each
row defaults to **Use global setting** and may select a project override. The UI
shows both the override and the resolved model.

Feature surfaces show resolved routing near important actions. Examples:

- “Gemini watches the recording; Claude writes the script.”
- “Timing analysis uses Gemini 2.5 Pro.”
- “Using the project override: Codex.”

Video-grounding controls are based on the resolved video role, not the writing
provider. When a recording exists, video grounding remains the default. If the
video assignment is missing or unhealthy, the control explains why and links
to model settings.

## Error Handling and Preservation Rules

- No AI failure rolls back a completed upload or recording attachment.
- No failed regeneration overwrites an existing script, scene description, or
  lower-third set.
- No requested video-grounded operation falls back to metadata-only analysis.
- No role falls back to another model entry.
- Provider diagnostics are logged privately; public errors contain a stable
  code and actionable, bounded copy.
- A stale brief is never treated as current merely because regeneration failed.
- Deleting a model entry is blocked while a global or project assignment
  references it. The API returns the referencing roles/projects so the UI can
  direct reassignment first.

## Migration

On first load of an unversioned model file:

1. Convert the file to version 2.
2. Remove the persisted `active` flags from model entries.
3. Assign the previously active entry to `writing` and `general` to preserve
   existing text behavior.
4. Assign the first ready configured Gemini entry to `video-understanding`.
5. Leave `video-understanding` unassigned when no ready Gemini entry exists.
6. Save the migrated file atomically.

If the previously active model was Gemini, it remains the initial writer. VPA
does not guess that a configured Claude or Codex entry is preferred. Settings
clearly recommends choosing a dedicated writing model, but migration does not
change existing text output without user action.

Legacy environment variables continue to seed missing catalog entries. They do
not override persisted role assignments after migration.

## API Shape

The settings API adds endpoints to read and update global assignments and to
return resolved readiness:

- `GET /api/settings/model-routing`
- `PUT /api/settings/model-routing`

Project APIs add:

- `GET /api/projects/:id/model-routing`
- `PUT /api/projects/:id/model-routing`

Responses include configured assignment IDs, resolved model summaries,
capabilities, and readiness. Update requests accept only known role keys and
model entry IDs or `null` to clear an assignment. Project updates persist only
overrides.

Existing feature responses that report `mode: "text" | "video"` retain that
field and add the resolved role/model summaries needed for transparent UI copy.

## Observability and Security

Structured logs include operation name, task role, model entry ID, provider,
concrete model ID, brief freshness state, and phase. They never include API
keys, authorization headers, full prompts, video contents, or visible-text
artifact contents.

Gemini uploads use the existing bounded Files API adapter and cleanup behavior.
Project overrides contain opaque local model IDs only. The browser never
receives stored API keys.

## Testing Strategy

Unit tests cover:

- Version 1/unversioned catalog migration and atomic persistence.
- Global assignment resolution.
- Project override precedence and clearing.
- Missing entry, missing API key, incompatible capability, and unavailable
  provider errors.
- One-model-per-role behavior with no fallback.
- Model deletion protection across global and project references.
- Brief schema validation, freshness, invalidation, and bounded timestamp rules.
- In-flight brief generation deduplication and Gemini cleanup.
- Gemini brief to writing-model script flow.
- Gemini timing to writing-model lower-third flow.
- Preservation of existing content on either stage’s failure.

Route tests cover global and project routing APIs, sanitized model summaries,
upload preservation, dry-run reanalysis, video-grounded scripts, and lower
thirds. Provider doubles verify that video bytes are only sent to Gemini and
that the writing model receives only structured text context.

Web tests cover model assignment selectors, capability filtering, readiness
copy, global defaults, project overrides, resolved-model labels, disabled video
actions, and remediation links.

An end-to-end test uses fake video and text providers to exercise:

1. Upload and attach a recording.
2. Generate and persist a video brief.
3. Generate a script with a different writing model.
4. Reuse the brief for lower thirds.
5. Change the project’s video assignment and verify that the brief becomes
   stale and is regenerated.

## Rollout Boundaries

Implementation should land in independently testable increments: catalog
migration and routing, settings APIs and global UI, project overrides, video
brief generation, staged script generation, staged lower thirds, remaining
text-role migrations, and end-to-end verification. The old `getActive()` and
shared `SwappableLlm` paths are removed only after every consumer has moved to
the router.

# Task-Based Model Routing

VPA assigns models to jobs instead of keeping one active model for the whole app. Configure global defaults in **Settings → Model assignments**, then use **Project Overview → AI models** only when a project needs a different specialist.

## The three roles

| UI label                     | Routing role          | Responsibility                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Watch and analyze video**  | `video-understanding` | Receives recordings, identifies visible changes, and creates timing-grounded observations. This must be a ready Gemini configuration with video capability.                                                                                      |
| **Write and refine content** | `writing`             | Writes scripts, rewrites, ideation copy, shot-plan prose, and lower-third wording from text context. Claude Code or Codex CLI is the recommended dedicated writer; Gemini, Anthropic, OpenAI-compatible, and test entries can also provide text. |
| **General analysis**         | `general`             | Handles source summarization, brand analysis, quality review, and utility classification. It can share the writing assignment, but remains independently configurable.                                                                           |

A common setup is Gemini for **Watch and analyze video**, Claude or Codex for **Write and refine content**, and the same writer or a less expensive text model for **General analysis**. Feature code requests one of these roles; it does not select a workflow by checking a provider name.

Settings readiness checks validate configuration or local CLI availability without issuing a billable completion. A role is ready only when its assignment exists, the referenced model still exists, the provider is available, and the role's capability requirements are met.

## Global defaults and project overrides

Global assignments apply to every project by default. Each project role starts at **Use global setting** and can be overridden independently. Resolution order is:

1. A project override for the requested role, when present.
2. The global assignment for that role.

Clearing a project override immediately restores the global assignment. Clearing a global assignment leaves inheriting projects unassigned; VPA does not choose another catalog entry automatically. Project files store only opaque model entry IDs under `model_routing`; credentials and endpoints remain in the local global catalog at `<VPA_HOME>/models.json`.

The resolved specialists are named beside grounded scene actions. Script and lower-third workflows name both stages, for example, “Gemini watches the recording; Codex writes the script.” Grounded reanalysis is intentionally different: Gemini analyzes the recording and VPA deterministically prepares the preview; no writing model is attributed because that workflow does not call one.

## Video privacy and the local brief

Only the resolved Gemini video model receives video bytes. VPA uploads the recording through the private Gemini Files transport, waits for processing, validates the returned JSON, and attempts to delete the remote file in a best-effort cleanup path.

The writing model never receives the recording, a local recording path, the SHA-256 fingerprint, Gemini credentials, model metadata, or a Gemini file URI. It receives bounded text context built from the validated brief: an ordered segment index, selected visual details, visible labels and terms, and pacing or narration cues. Lower-third writers return segment IDs and copy; VPA maps those IDs back to server-validated times.

The complete validated brief stays inside the project at:

```text
analysis/video/<scene-id>.json
```

It may contain visible on-screen text, so treat it as private project data. It is current only while all of these values match:

- the recording's SHA-256 fingerprint;
- the assigned video model entry ID and concrete model ID;
- the brief schema version;
- the video-understanding prompt version.

Replacing a recording, changing the effective video assignment, or changing a schema or prompt version makes the brief stale. The next grounded action regenerates it. Concurrent requests for the same scene and freshness key share one in-flight analysis, and successful downstream actions reuse a current brief instead of uploading the recording again.

### Inspect or remove a brief

From the project directory, inspect a brief with a text editor or:

```bash
jq . analysis/video/<scene-id>.json
```

To discard only the derived analysis, delete that one JSON file in Finder or run this from the project directory after replacing `<scene-id>` with the exact scene ID:

```bash
rm -- analysis/video/<scene-id>.json
```

This does not modify `recordings/<scene-id>.mp4`, the storyboard, scripts, or lower thirds. The next video-grounded action creates a new brief. Do not delete the `recordings/` file when the intent is only to refresh analysis.

## Failures never fall back

VPA reports routing failures with stable codes:

- `model_assignment_missing`
- `model_assignment_invalid`
- `model_capability_mismatch`
- `model_unavailable`

The message identifies the affected role and directs you to the project or global assignment section. A project row that inherits a broken global assignment links to **Settings → Model assignments**. Grounded scene failures link back to **Project Overview → AI models** so the effective project/global choice is visible.

There are no backup chains or provider substitutions. In particular:

- a failed grounded request never becomes a metadata-only or text-only request;
- an unavailable writer does not trigger another writer or a new Gemini upload;
- a failed upload-time analysis does not detach or delete the recording;
- failed script, scene-metadata, or lower-third generation does not overwrite existing authored content;
- a stale brief is not accepted merely because regeneration failed.

After fixing the named assignment, retry the original action explicitly.

## Reassign before deleting a model

VPA blocks deletion while any global assignment or project override references the model. The model card lists the affected global jobs and projects and links to their assignment sections.

1. Reassign or clear every listed project override.
2. Reassign or clear every listed global role.
3. Return to the model library and delete the now-unreferenced configuration.

This guard prevents a catalog cleanup from silently breaking existing projects.

## Migration from the old active model

When VPA first reads an unversioned or version-1 catalog, it writes the version-2 role-based shape atomically:

1. The previously active entry becomes the initial `writing` and `general` assignment.
2. The first ready configured Gemini entry becomes `video-understanding`.
3. If no ready Gemini entry exists, video understanding remains unassigned.
4. Legacy `active` flags are removed.

If the old active entry was Gemini, it remains the initial writer; migration does not guess that another configured model is preferred. Legacy environment variables may seed missing catalog entries, but they do not replace persisted role assignments after migration.

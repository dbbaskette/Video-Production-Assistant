# Browser Capture and Non-Destructive Composition Design

## Scope

This design groups P1 issues #92 and #93 because browser capture must produce the same immutable, independently timed source tracks consumed by editing and rendering. It builds on the asset, revision, and durable-job contracts from #90, #91, and #99. Native upload and Cap capture remain supported source methods.

The bounded pilot targets desktop Chrome and Edge on macOS and Windows, at browser-selected quality up to 1080p/30 fps and 20 minutes. It does not add live source switching, pause/resume, remote guests, variable-speed editing, or a professional free-form timeline.

## Browser capture lifecycle

A new Browser capture panel lives on the Recordings page. Capture is always initiated by a button click. `Prepare capture` asks the browser for a display stream and, only when selected, microphone and webcam streams. The preflight shows the actual display and camera previews, microphone level, selected MIME type, and whether the chosen display stream really contains shared audio. VPA never labels system audio as available merely because it was requested.

`Start recording` is a second explicit action. It performs a three-second countdown and then starts one `MediaRecorder` per independent track: screen video, camera video, microphone audio, and shared/system audio. Every recorder uses a shared monotonic clock origin and emits ordered chunks. The client serializes uploads per track and waits for durable acknowledgements. Elapsed time and acknowledged-chunk state are visible. The browser stops automatically at 20 minutes.

Stop, cancel, track-ended, upload failure, recorder failure, and component cleanup all stop every recorder and every acquired media track. Stop finalizes after pending uploads settle. Cancel preserves acknowledged chunks as an incomplete take unless the user explicitly discards later; this makes interruption recoverable without claiming the take is complete.

## Durable capture sessions

Each project stores browser-capture session metadata and chunks under `.vpa/captures/<session-id>/`. The session record contains project/scene identity, a common clock, actual track descriptors and MIME types, ordered chunk acknowledgements, bounded diagnostics, and status (`recording`, `incomplete`, `assembling`, `completed`, `failed`, or `cancelled`). Session and chunk writes are atomic and serialized per session.

Chunk requests are idempotent by `(session, track, sequence)`. Repeating identical bytes returns the existing acknowledgement; different bytes for the same key conflict. Completion requires a contiguous sequence for every reported track. The server concatenates each browser stream, validates it with ffprobe, and imports it into the immutable asset library with its actual role and shared timing origin. A session becomes completed only after every track is a playable immutable asset. Failed or interrupted assembly leaves the chunks and a retry action. Listing sessions turns stale `recording` records into visibly incomplete recoverable takes.

## Composition model

Each scene may have a versioned `composition`:

- `clips` is an ordered sequence of clip instances. Each instance has a unique `clip_` ID, an immutable primary asset reference, integer millisecond source in/out, integer millisecond timeline start, and linked tracks. Linked tracks reference independent immutable assets with a source-relative offset and role.
- `audio_mix` contains understandable fixed controls for original/shared audio, microphone, camera audio, narration, and music: gain in dB, mute, and fixed fade-in/fade-out milliseconds.
- The total duration is derived from the canonical clip sequence; timeline starts are normalized after every edit.

Existing scenes remain valid. Composition is initialized explicitly from the scene's existing recording/source tracks. The legacy `recording` field remains a compatibility preview source, while renderers prefer composition when present.

## Validated edit operations

The authoritative revision command API adds composition initialization, trim, split, delete, reorder, duplicate, and audio-mix commands. Every operation validates the whole resulting composition in memory before a revision commit.

- Trim changes source in/out for the clip and all linked tracks as one linked unit.
- Split replaces one instance with two new instances whose ranges meet at the split point; linked tracks follow both halves.
- Duplicate creates a new instance ID while preserving immutable source references and linked offsets.
- Delete and reorder operate on instance IDs and normalize sequence starts.
- Audio mix controls are bounded and role-specific.

Invalid ranges, unknown assets, non-audio assets in audio-only roles, duplicate IDs, stale revisions, and incomplete reorder lists fail atomically. Restore works through the existing revision snapshot mechanism and therefore restores composition and mix choices without changing source assets. UI and Codex both use these commands.

Source-anchored captions and effects are represented in source time. This group supplies the clip/source mapping helpers consumed by #94 and #95; split, trim, reorder, and duplicate preserve those anchors because they never rewrite the underlying source time.

## Preview and render semantics

A lightweight editor on Recordings shows each scene as ordered clip blocks with trim fields, split, duplicate, delete, and move controls plus the small audio mixer. Its duration and inclusion calculations use shared composition helpers.

The render pipeline materializes a composed scene before overlays, frames, subtitles, and final concatenation. It trims and concatenates primary video clips in sequence order, builds each linked audio lane from the same source windows, applies gain/mute/fades, and mixes only enabled lanes. Narration and project music enter through their existing paths but obey the same persisted mix settings. Missing shared audio is omitted rather than synthesized or promised; silent enabled tracks are safe. A single source is never included twice for the same role and clip.

Both per-scene and full-project rendering call the same composition materializer, so preview metadata and exports use the same duration, inclusion, gain, and fade model. Generated intermediates are derived files; immutable source bytes are never modified.

## Failure behavior and compatibility

- Permission denial produces a specific preflight message and releases streams already acquired.
- Device loss/source-track end stops recording and marks the take incomplete.
- Server interruption leaves acknowledged chunks discoverable and recoverable.
- Incomplete upload or invalid assembly never creates a successful asset/session state.
- Existing upload, Cap, split, and presentation recordings continue to render unchanged until a composition is created.
- Browser capability detection blocks unsupported browsers or MIME combinations before recording.
- Public errors remain bounded and do not expose project paths or provider details.

## Verification

Automated tests cover schema bounds, command atomicity, linked edits, repeated assets, restore, chunk idempotency/conflict/ordering, stale-session recovery, malformed assembly, permission/device/source-end cleanup, actual shared-audio detection, MIME selection, absent audio, microphone-only mixing, original-plus-narration, fades/gains, and identical preview/export duration calculation.

The final gate is build, typecheck, all workspace tests, focused ESLint on changed files, a diff audit against #92/#93, and documented manual pilot checks for Chrome/Edge on macOS/Windows where physical browser/OS permission prompts cannot be exercised in CI.

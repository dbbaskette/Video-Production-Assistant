# VPA CLI and Codex Production Skill Design

## Status and roadmap relationship

This specification implements the first concrete automation slice of roadmap issue #88 and the CLI-first direction in #89. Issue #88 remains the umbrella for the broader production roadmap; its other owner issues are not collapsed into this change. The later MCP transport remains #120 and must wrap, not duplicate, the interfaces defined here.

## Outcome

Codex and ordinary terminal users can discover VPA projects and narration capabilities, create standalone narration artifacts, start project-wide narration, and inspect or wait for jobs through a deterministic `vpa` CLI. A repository skill teaches Codex how to select and verify these operations without replacing VPA's validation or provider configuration.

VPA remains the owner of provider credentials, project data, narration generation, jobs, and artifacts. The CLI is an HTTP client for the local VPA API.

## Consumers

- Codex operating in this repository through the `vpa-production` skill.
- A human using a terminal for inspection or automation.
- Future MCP tools in #120, which must expose equivalent contracts.

## Commands

The root development entry point is `npm run vpa -- <command>`. The built package also exposes a `vpa` binary.

### Discovery

```text
vpa narration engines list [--json]
vpa narration voices list [--engine ID] [--json]
vpa narration profiles list [--json]
vpa narration options describe --engine ID [--json]
vpa projects list [--json]
vpa projects show PROJECT_ID [--json]
```

Narration engine discovery returns stable IDs, names, voices, readiness, speed bounds/default, direct-synthesis expressiveness levels, supported speech tags, output formats, timing/subtitle support, multi-speaker support, and input limits. Only configured providers are advertised; therefore advertised providers report `ready: true`. Missing providers are absent rather than exposing credentials or environment details.

### Narration

```text
vpa narration create (--text TEXT | --text-file PATH)
  (--profile ID | --engine ID --voice ID)
  [--speed N] [--expressiveness LEVEL]
  [--output PATH] [--json]

vpa narration project PROJECT_ID
  (--profile ID | --engine ID --voice ID)
  [--speed N] [--expressiveness LEVEL]
  [--overwrite] [--wait] [--json]
```

Standalone narration uses VPA's persisted scratch-artifact API and downloads the playable audio when `--output` is supplied. Project narration reuses the existing asynchronous project job endpoint. A profile supplies engine, voice, and speed; explicitly supplied options override the profile.

Generation validates the selected engine, voice, speed range, expressiveness enum, and input limit. Standalone expressiveness is additionally checked against the selected provider's direct-synthesis capabilities. Project narration accepts VPA's light/medium/heavy preparation levels, including the xAI writing-model tag pass. Unsupported choices return structured errors; there is no silent provider, voice, or speed substitution.

### Jobs

```text
vpa jobs show JOB_ID [--json]
vpa jobs wait JOB_ID [--interval-ms N] [--timeout-ms N] [--json]
```

`wait` polls the bounded job-status endpoint until completion, failure, cancellation, or timeout. It does not infer success from progress prose.

## Output and errors

- `--json` emits exactly one JSON document to stdout.
- Human output remains concise and is not an automation contract.
- API failures emit a JSON error to stderr in JSON mode and use a nonzero exit status.
- Connection failures use code `vpa_unavailable` and identify the configured base URL without exposing credentials.
- CLI argument/selection failures use code `invalid_request`.
- `VPA_API_URL` overrides the default `http://127.0.0.1:3000`.
- The CLI never reads `.env` or provider secrets; the VPA server started by `start.sh` owns that configuration.

## API additions

`GET /api/tts/engines` is extended compatibly with:

```ts
{
  ready: true;
  capabilities: {
    speed: { min: number; max: number; default: number };
    expressiveness: Array<'light' | 'medium' | 'heavy'>;
    multiSpeaker: boolean;
    outputFormats: Array<'mp3' | 'wav'>;
    timings: 'estimated' | 'word' | 'none';
    subtitles: boolean;
    maxInputChars: number;
  };
}
```

`POST /api/tts/scratch` accepts optional `profile`, `expressiveness`, and explicit overrides. It resolves and validates the effective selection before provider invocation and returns the effective settings with the persisted clip metadata. Existing engine/voice requests remain compatible.

## Provider truthfulness

- xAI advertises and receives native speed `0.7–1.5`.
- Gemini currently advertises fixed numeric speed `1.0`; its expressive pacing remains qualitative, not a false numeric promise.
- Qwen and fake providers advertise the range their adapters accept.
- Capability metadata is owned by each provider implementation and returned by `TtsService`, preventing UI/CLI drift.

## Skill contract

`.agents/skills/vpa-production/SKILL.md` instructs Codex to:

1. Confirm the VPA API is available.
2. Discover engines/profiles/options before choosing narration settings.
3. Prefer a user-named profile; otherwise make an explicit engine/voice selection.
4. Never silently fall back or overwrite existing project narration.
5. Use job IDs and terminal status for project narration.
6. Verify downloaded audio exists and is non-empty before reporting success.
7. Keep credentials and private project paths out of prompts and output.

## Compatibility and exclusions

- Existing browser API consumers continue to work because fields and request options are additive.
- Existing project narration semantics—skip scenes without scripts and preserve audio unless overwrite is set—remain unchanged.
- This slice does not implement arbitrary project mutation batches, revision storage, durable cross-restart jobs, feedback claims, render commands, or MCP. Those remain staged work in #89/#90/#91/#97/#99/#120.
- This slice does not start VPA automatically; connection failure instructs the caller to use `start.sh` so `.env` remains server-owned.

## Acceptance criteria

- CLI discovers the same configured engines, voices, profiles, and capability bounds as the browser API.
- A standalone fake-provider narration can be created and downloaded without paid-service access.
- Invalid engine, voice, profile, speed, expressiveness, or oversized text fails before provider work.
- Project narration starts through the CLI and returns a job ID; `jobs wait` reports only terminal job state.
- JSON output is stable and contains no terminal decoration.
- The skill is present and its documented commands match CLI help.
- Server, CLI, shared, and relevant web compatibility tests pass; the repository builds and typechecks.

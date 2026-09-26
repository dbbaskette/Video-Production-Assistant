---
name: vpa-production
description: Use VPA from Codex for narration discovery, standalone voice artifacts, project-wide narration, project inspection, bounded draft recipes, and job status.
---

# Use VPA production services

Run commands from the VPA repository root with `npm run vpa -- ...`. The CLI talks to the local VPA API; VPA owns provider credentials, projects, jobs, and artifacts.

## Availability and discovery

Start by running the relevant discovery commands. If the CLI reports `vpa_unavailable`, start the application with `./start.sh` so VPA loads its own `.env`, then retry. Never read, print, copy, or pass provider secrets to the CLI.

```bash
npm run vpa -- projects list --json
npm run vpa -- narration engines list --json
npm run vpa -- narration voices list --engine ENGINE_ID --json
npm run vpa -- narration profiles list --json
npm run vpa -- narration options describe --engine ENGINE_ID --json
npm run vpa -- production recipes list --json
```

Use the IDs and bounds returned by discovery. Prefer a profile the user names. Otherwise, make the engine and voice explicit from the advertised choices. Never silently substitute a provider, voice, speed, or expressiveness setting after an error.

## Standalone narration

Create narration from inline text or a UTF-8 file. Use `--output` when the caller needs a local artifact.

```bash
npm run vpa -- narration create --text-file SCRIPT.txt --profile PROFILE_ID --output narration.mp3 --json
npm run vpa -- narration create --text "Text to speak" --engine ENGINE_ID --voice VOICE_ID --speed 1.1 --output narration.wav --json
```

After a download, verify the reported output path exists and is non-empty before reporting success. Do not claim a file was created from clip metadata alone.

## Project narration

Inspect the project when needed, then start narration with either a profile or explicit engine and voice:

```bash
npm run vpa -- projects show PROJECT_ID --json
npm run vpa -- narration project PROJECT_ID --profile PROFILE_ID --wait --json
npm run vpa -- narration project PROJECT_ID --engine ENGINE_ID --voice VOICE_ID --wait --json
```

VPA skips scenes without scripts. It preserves existing scene narration unless the user explicitly asks to replace it; only then add `--overwrite`. A job is successful only when its terminal `status` is `completed`. Treat `failed`, `cancelled`, and CLI timeout as unsuccessful even if earlier progress was reported.

For a previously returned job ID:

```bash
npm run vpa -- jobs show JOB_ID --json
npm run vpa -- jobs wait JOB_ID --json
```

## Playable draft recipes

Inspect before running. The inspection reads the real storyboard and source media and returns blockers and exact recipe effects. Do not run a blocked recipe or represent an inspection/plan as a produced draft.

```bash
npm run vpa -- production inspect PROJECT_ID clean-walkthrough --json
npm run vpa -- production inspect PROJECT_ID feature-demo --json
npm run vpa -- production inspect PROJECT_ID revise-this-draft --json
```

Run only the reviewed recipe and wait for the underlying render job. Success requires terminal `completed` state and a video artifact in the job result.

```bash
npm run vpa -- production run PROJECT_ID RECIPE --wait --json
```

`clean-walkthrough` preserves sources and includes prepared narration and overlays. `feature-demo` requires screen sources and preserves source audio. `revise-this-draft` requires at least one resolved visual-feedback note and renders that revision. Recipe runs create a restorable draft revision; they never delete source media.

## Boundaries

- Do not start paid narration merely to test the workflow. Use the advertised `fake` provider for safe development checks.
- Do not infer permission to overwrite existing narration.
- Do not edit project files behind VPA's API.
- Do not expose private project paths or credentials in summaries or prompts.
- Stop on structured CLI errors and report the code and concise remedy; do not improvise a provider fallback.

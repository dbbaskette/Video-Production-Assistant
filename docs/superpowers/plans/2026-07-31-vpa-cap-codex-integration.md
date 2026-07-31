# VPA-Managed Cap and Codex CLI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user install and use Cap entirely from VPA, dispatch rehearsals directly to Codex CLI, confirm capture in VPA, and attach a validated local recording without copying prompts.

**Architecture:** VPA owns Cap discovery, installation, capture, validation, export, and ingestion. A reusable Codex JSONL adapter supports both an ordinary `codex-cli` LLM provider and a persistent scene-runner thread. A session-scoped macOS driver lets Codex inspect and operate only the approved target application while the server-owned coordinator enforces state, confirmation, and cleanup.

**Tech Stack:** TypeScript 5.6, Node.js child processes and filesystem APIs, Fastify 4, Zod 3, React 18, TanStack Query 5, Vitest, Playwright, macOS `osascript`/Accessibility and `screencapture`, Cap Desktop CLI, Codex CLI.

## Global Constraints

- Cap remains a separate runtime dependency; do not clone, vendor, fork, or link against Cap source.
- Use Cap's released Desktop + CLI distribution and invoke a verified absolute CLI path.
- The install endpoint uses only the fixed official `https://cap.so/install-cli.sh` URL and requires `{ confirmed: true }`.
- Set `CAP_CLI_INSTALL_DIR` to `path.join(vpaHome, 'bin')` and `CAP_NO_MODIFY_PATH=1`; do not alter shell profiles.
- Do not install Cap's global Codex skill or MCP configuration.
- Local scene recording must not authenticate to, upload to, or share through Cap Cloud.
- VPA owns Cap start, exact-ID stop, project validation, export, ingestion, and session transitions.
- Codex owns only rehearsal and target-application actions through the constrained desktop driver.
- Recording requires a successful rehearsal followed by a session-bound **Confirm & record** action in VPA.
- Reject Terminal, ChatGPT, Cap, VPA, System Settings, password managers, and any application other than the reviewed target.
- Microphone, camera, and system audio default off; cursor defaults on.
- Initial automated desktop support is macOS-only; manual upload remains available everywhere.
- Do not automate macOS privacy or security permission prompts.
- Implement changes in coherent functional increments and run targeted tests at task boundaries; run the full relevant suite once before completion.

---

## File Structure

### Shared contracts

- Modify `packages/shared/src/agent-recording.ts` — public Cap setup, rehearsal evidence, coordinator request, and session-state schemas.
- Modify `packages/shared/src/agent-recording.test.ts` — contract/default/transition-facing schema tests.

### Server process and Codex support

- Create `apps/server/src/services/process/jsonl-process.ts` — injectable JSONL subprocess runner with timeout, abort, stderr bounds, and event callbacks.
- Create `apps/server/src/services/process/jsonl-process.test.ts` — deterministic subprocess parsing tests using an injected spawn double.
- Create `apps/server/src/services/llm/providers/codex-cli.ts` — ordinary `LlmClient` adapter.
- Create `apps/server/src/services/llm/providers/codex-cli.test.ts` — argument, stdin, output, and error tests.
- Create `apps/server/src/services/agent-recording/codex-runner.ts` — persistent rehearsal/resume adapter and structured-output schemas.
- Create `apps/server/src/services/agent-recording/codex-runner.test.ts` — thread ID, resume, and malformed evidence tests.
- Modify `apps/server/src/config.ts`, `apps/server/src/services/llm/factory.ts`, and `apps/server/src/services/llm/model-registry.ts` — `codex-cli` provider registration.
- Modify `apps/web/src/pages/Settings.tsx` and `apps/web/src/lib/api.ts` — Codex CLI provider choice and types.

### Cap runtime and setup

- Create `apps/server/src/services/cap/types.ts` — internal Cap command/result interfaces.
- Create `apps/server/src/services/cap/locator.ts` — ordered absolute-path discovery and verification.
- Create `apps/server/src/services/cap/runtime.ts` — guide, doctor, targets, detached start/stop, validation, export, and persisted setup status.
- Create `apps/server/src/services/cap/installer.ts` — confirmed official installer job with fixed environment.
- Create `apps/server/src/services/cap/runtime.test.ts` and `apps/server/src/services/cap/installer.test.ts` — fake-process and fake-download coverage.
- Modify `apps/server/src/routes/setup.ts` and create `apps/server/src/routes/setup.test.ts` — Cap status/install/check routes.
- Modify `apps/server/src/server.ts` — construct one Cap runtime/installer and register dependencies.

### Desktop control

- Create `apps/server/src/services/desktop-driver/types.ts` — target, snapshot, element, command, and result contracts.
- Create `apps/server/src/services/desktop-driver/macos.ts` — fixed JXA/Accessibility and window screenshot operations.
- Create `apps/server/src/services/desktop-driver/session.ts` — opaque capability creation, target binding, expiry, stale-index protection, and cleanup.
- Create `apps/server/src/services/desktop-driver/session.test.ts` — security-boundary tests with a fake macOS adapter.
- Create `apps/server/src/routes/agent-desktop.ts` — bearer-protected loopback driver endpoints.
- Create `scripts/vpa-desktop-driver.mjs` — tiny CLI client used by Codex; it can call only the loopback driver endpoints.

### Recording coordination and routes

- Modify `apps/server/src/services/agent-recording/session.ts` and its tests — coordinator-owned state and private fields.
- Create `apps/server/src/services/agent-recording/coordinator.ts` — rehearsal, confirmation, recording, export, attachment, cancellation, and reconciliation.
- Create `apps/server/src/services/agent-recording/coordinator.test.ts` — fake Cap/Codex/driver/ingestion end-to-end state tests.
- Modify `apps/server/src/routes/agent-recording.ts` and `apps/server/src/routes/agent-recording.test.ts` — rehearse/confirm/cancel endpoints and removal of browser-controlled transitions.
- Modify `apps/server/src/routes/recordings.ts` and `apps/server/src/routes/recordings.test.ts` — keep provenance compatibility while coordinator calls authoritative ingestion directly.
- Modify `apps/server/src/server.ts` — wire coordinator and loopback desktop route.

### Web UX and documentation

- Modify `apps/web/src/lib/api.ts` — setup and coordinator mutations.
- Rewrite `apps/web/src/components/AgentRecordingDialog.tsx` — setup, rehearsal, confirmation, recording, cancel, completion, and fallback states.
- Modify `apps/web/src/components/AgentRecordingStatus.tsx` — `awaiting_confirmation` and coordinator phase copy.
- Modify `apps/web/src/styles.css` — setup panel, progress steps, confirmation summary, and responsive actions.
- Create `tests/e2e/agent-recording.spec.ts` — fake-backed missing-Cap, rehearsal, confirmation, failure, and completion flows.
- Modify `.agents/skills/vpa-agent-recording/SKILL.md` and `scripts/check-agent-recording-skill.mjs` — make VPA-owned Cap lifecycle explicit and remove obsolete direct-Cap commands from Codex's responsibilities.
- Modify `docs/agent-recording-cap.md` and the superseded design note — document direct dispatch, setup, and real acceptance boundaries.

---

### Task 1: Extend shared contracts and make sessions coordinator-owned

**Files:**
- Modify: `packages/shared/src/agent-recording.ts`
- Modify: `packages/shared/src/agent-recording.test.ts`
- Modify: `apps/server/src/services/agent-recording/session.ts`
- Modify: `apps/server/src/services/agent-recording/session.test.ts`

**Interfaces:**
- Produces `CapSetupStatus`, `AgentRehearsalEvidence`, `AgentRecordingRehearseRequest`, `AgentRecordingConfirmRequest`, and the `awaiting_confirmation` state.
- Produces internal server functions `createAgentRecordingSession`, `transitionAgentRecordingSession`, `readStoredAgentRecordingSession`, and `findRecoverableAgentRecordingSession`.
- Removes the shared browser-facing arbitrary session update schema from route use.

- [ ] **Step 1: Add public setup and rehearsal schemas**

Add contracts equivalent to:

```ts
export const CapSetupStateSchema = z.enum([
  'not-installed', 'installing', 'needs-permission', 'ready', 'error',
]);

export const CapSetupStatusSchema = z.object({
  state: CapSetupStateSchema,
  installed: z.boolean(),
  cliPath: z.string().optional(),
  version: z.string().optional(),
  captureReady: z.boolean(),
  missingPermissions: z.array(z.enum(['screen-recording', 'accessibility'])),
  targetCount: z.number().int().nonnegative().default(0),
  installationId: z.string().uuid().optional(),
  message: z.string().optional(),
  updatedAt: z.string().datetime(),
});

export const AgentRehearsalEvidenceSchema = z.object({
  success: z.boolean(),
  targetApplication: z.string(),
  windowTitle: z.string(),
  windowBounds: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
  completedStepIndexes: z.array(z.number().int().nonnegative()),
  checkpoints: z.array(z.object({ description: z.string(), passed: z.boolean(), detail: z.string().optional() })),
  resetConfirmed: z.boolean(),
  diagnostic: z.string().max(2000).optional(),
});
```

Add `awaiting_confirmation` to the state enum. Add optional public session fields `phase`, `planFingerprint`, `rehearsal`, and `confirmedCapture`. Define request schemas:

```ts
export const AgentRecordingRehearseRequestSchema = AgentRecordingPlanUpdateSchema;
export const AgentRecordingConfirmRequestSchema = z.object({
  confirmed: z.literal(true),
  planFingerprint: z.string().min(1),
});
```

- [ ] **Step 2: Move private session data behind the server store**

Define a non-exported `StoredSession` containing:

```ts
interface StoredSession extends AgentRecordingSession {
  codexThreadId?: string;
  driverTokenHash?: string;
  targetApplicationId?: string;
  recordingId?: string;
  capProjectPath?: string;
  exportPath?: string;
  capturedAt?: string;
  events?: Array<{ at: string; phase: string; message: string }>;
}
```

Use this transition map:

```ts
const transitions = {
  rehearsing: ['awaiting_confirmation', 'failed', 'interrupted'],
  awaiting_confirmation: ['recording', 'failed', 'interrupted'],
  recording: ['exporting', 'failed', 'interrupted'],
  exporting: ['attaching', 'failed', 'interrupted'],
  attaching: ['completed', 'failed', 'interrupted'],
  completed: [], failed: [], interrupted: [],
} satisfies Record<AgentRecordingSessionState, AgentRecordingSessionState[]>;
```

Expose public sessions only through `AgentRecordingSessionSchema.parse`. Keep exact IDs and local paths internal. Cap the event log at 100 entries.

- [ ] **Step 3: Update session and schema tests**

Cover:

- setup defaults and invalid permission names;
- successful rehearsal evidence parsing;
- `rehearsing -> awaiting_confirmation -> recording -> exporting -> attaching -> completed`;
- rejection of direct `rehearsing -> recording` and stale plan fingerprints;
- private paths absent from public session output;
- expiry and recoverable export/attachment state.

- [ ] **Step 4: Run the shared/session milestone tests**

Run:

```bash
npm test -w @vpa/shared -- src/agent-recording.test.ts
npm test -w @vpa/server -- src/services/agent-recording/session.test.ts
npm run typecheck -w @vpa/shared
npm run typecheck -w @vpa/server
```

Expected: all selected tests pass and both workspaces typecheck.

- [ ] **Step 5: Commit the contract slice**

```bash
git add packages/shared/src/agent-recording.ts packages/shared/src/agent-recording.test.ts apps/server/src/services/agent-recording/session.ts apps/server/src/services/agent-recording/session.test.ts
git commit -m "feat: extend agent recording session contracts"
```

---

### Task 2: Add the Codex CLI process adapter and model provider

**Files:**
- Create: `apps/server/src/services/process/jsonl-process.ts`
- Create: `apps/server/src/services/process/jsonl-process.test.ts`
- Create: `apps/server/src/services/llm/providers/codex-cli.ts`
- Create: `apps/server/src/services/llm/providers/codex-cli.test.ts`
- Create: `apps/server/src/services/agent-recording/codex-runner.ts`
- Create: `apps/server/src/services/agent-recording/codex-runner.test.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/services/llm/factory.ts`
- Modify: `apps/server/src/services/llm/model-registry.ts`
- Modify: `apps/web/src/pages/Settings.tsx`
- Modify: `apps/web/src/lib/api.ts`

**Interfaces:**
- Produces `runJsonlProcess(request, deps?)`.
- Produces `createCodexCliLlm(model?, deps?)`.
- Produces `CodexSceneRunner.rehearse(...)` and `CodexSceneRunner.resumeForRecording(...)`.
- Consumes `AgentRehearsalEvidenceSchema` from Task 1.

- [ ] **Step 1: Build an injectable JSONL subprocess runner**

Use this public shape:

```ts
export interface JsonlProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
}

export interface JsonlProcessResult {
  events: Array<Record<string, unknown>>;
  stderr: string;
  exitCode: number;
}
```

Split stdout by newline, parse each nonblank line once, retain at most 500 events, bound stderr to 16 KiB, terminate on timeout/abort, and reject with a normalized error on spawn failure, nonzero exit, malformed terminal output, or timeout.

- [ ] **Step 2: Implement the ordinary Codex CLI LLM provider**

Construct arguments without a shell:

```ts
const args = ['exec', '--ephemeral', '--json', '--sandbox', 'read-only', '-C', workspaceRoot];
if (model && model !== 'default') args.push('--model', model);
args.push('-');
```

Send the composed system/user prompt via stdin. For JSON requests append the same valid-JSON-only constraint used by Claude. Extract the last completed `agent_message`; surface CLI error events and empty output as actionable errors.

- [ ] **Step 3: Implement persistent scene-runner calls**

`rehearse()` writes VPA's fixed JSON Schema to `path.join(sessionScratchDir, 'rehearsal-output.schema.json')`, runs non-ephemeral `codex exec --json --sandbox workspace-write --output-schema path.join(sessionScratchDir, 'rehearsal-output.schema.json') -C workspaceRoot -`, captures `thread.started`, and still validates the final message through `AgentRehearsalEvidenceSchema`.

`resumeForRecording()` runs:

```ts
['exec', 'resume', threadId, '--json', '-']
```

and requires a separate execution-evidence schema containing `success`, completed step indexes, checkpoint results, and diagnostic. Both prompts explicitly forbid repository edits, Cap commands, other applications, secrets, uploads, publishing, and destructive actions.

- [ ] **Step 4: Register `codex-cli` everywhere Claude CLI is registered**

Update provider unions, env validation, `CODEX_MODEL` selection, factory switches, and registry seeds:

```ts
entries.push({
  id: 'codex-cli',
  name: 'Codex CLI',
  provider: 'codex-cli',
  model: env.CODEX_MODEL || 'default',
  active: false,
});
```

Add Settings copy: **Codex CLI (codex exec)** with hint **Uses your local Codex login**. When selected in the add form, default an empty model field to `default` so the existing required-model validation remains valid.

- [ ] **Step 5: Cover process/provider/runner behavior**

Use injected process doubles to assert exact executable/args/stdin/env; test fragmented JSONL chunks, thread ID extraction, final-message selection, nonzero exit, timeout, abort, malformed rehearsal JSON, resume arguments, and default-model omission.

- [ ] **Step 6: Run the Codex milestone tests**

```bash
npm test -w @vpa/server -- src/services/process/jsonl-process.test.ts src/services/llm/providers/codex-cli.test.ts src/services/agent-recording/codex-runner.test.ts
npm run typecheck -w @vpa/server
npm run typecheck -w @vpa/web
```

- [ ] **Step 7: Commit Codex CLI support**

```bash
git add apps/server/src/services/process apps/server/src/services/llm apps/server/src/services/agent-recording/codex-runner.ts apps/server/src/services/agent-recording/codex-runner.test.ts apps/server/src/config.ts apps/web/src/pages/Settings.tsx apps/web/src/lib/api.ts
git commit -m "feat: add Codex CLI provider and scene runner"
```

---

### Task 3: Implement Cap discovery, setup, and typed recording runtime

**Files:**
- Create: `apps/server/src/services/cap/types.ts`
- Create: `apps/server/src/services/cap/locator.ts`
- Create: `apps/server/src/services/cap/runtime.ts`
- Create: `apps/server/src/services/cap/installer.ts`
- Create: `apps/server/src/services/cap/runtime.test.ts`
- Create: `apps/server/src/services/cap/installer.test.ts`
- Modify: `apps/server/src/routes/setup.ts`
- Create: `apps/server/src/routes/setup.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Produces `CapRuntime` and `CapInstaller` consumed by the coordinator and setup routes.
- Produces `GET /api/setup/cap`, `POST /api/setup/cap/check`, and `POST /api/setup/cap/install`.
- Consumes `CapSetupStatus` from Task 1 and `runJsonlProcess` from Task 2.

- [ ] **Step 1: Implement absolute-path discovery**

Evaluate candidates in the design order. Resolve symlinks, require executable access, and verify with `[candidate, ['version', '--json']]`. Do not accept a command merely because `which` found it.

Return:

```ts
export interface LocatedCap {
  cliPath: string;
  version: string;
}
```

Persist only `cliPath`, `version`, `verifiedAt`, and a bounded non-secret diagnostic under `path.join(vpaHome, 'setup', 'cap.json')`.

- [ ] **Step 2: Implement typed Cap operations**

Create injectable `CapProcess` methods and parse the installed guide before choosing command flags. The runtime methods are:

```ts
getStatus(force?: boolean): Promise<CapSetupStatus>;
guide(): Promise<Record<string, unknown>>;
doctor(): Promise<{ captureReady: boolean; missingPermissions: string[] }>;
targets(): Promise<CapTarget[]>;
startRecording(input: CapStartInput): Promise<{ recordingId: string; projectPath: string }>;
stopRecording(recordingId: string): Promise<{ recordingMetaExists: true; projectPath: string }>;
validateProject(projectPath: string): Promise<void>;
exportProject(projectPath: string, outputPath: string, signal?: AbortSignal): Promise<void>;
```

Reject missing IDs, missing paths, false diagnostic fields, invalid projects, nonterminal exports, or nonexistent/empty MP4s.

- [ ] **Step 3: Implement one confirmed installer job**

`CapInstaller.start({ confirmed: true })` must:

1. reject `confirmed !== true`;
2. reject a concurrent install;
3. download only `https://cap.so/install-cli.sh` to a fresh temporary directory;
4. run `/bin/sh` with the concrete downloaded temporary filename and `CAP_CLI_INSTALL_DIR=path.join(vpaHome, 'bin')` plus `CAP_NO_MODIFY_PATH=1`;
5. remove the temporary directory;
6. call locator verification independently;
7. publish `installing`, `ready`, or `error` through `getStatus()`.

Inject downloader and process functions in tests; no automated test may access the network or install Cap.

- [ ] **Step 4: Add setup routes and server wiring**

The install route returns `202` with `{ installationId, state: 'installing' }`. Status/check return parsed shared contracts. The health page's existing probes remain unchanged; Cap status is feature-specific and rendered in the recording dialog.

- [ ] **Step 5: Test discovery, commands, install safety, and routes**

Cover discovery precedence, stale path fallback, missing binary, doctor success with `captureReady: false`, target parsing, start/stop exact IDs, validation, JSONL export, fixed URL/env, confirmation requirement, duplicate install, installer failure, post-install re-verification, and route status codes.

- [ ] **Step 6: Run the Cap milestone tests**

```bash
npm test -w @vpa/server -- src/services/cap/runtime.test.ts src/services/cap/installer.test.ts src/routes/setup.test.ts
npm run typecheck -w @vpa/server
```

- [ ] **Step 7: Commit Cap runtime/setup**

```bash
git add apps/server/src/services/cap apps/server/src/routes/setup.ts apps/server/src/routes/setup.test.ts apps/server/src/server.ts
git commit -m "feat: add VPA-managed Cap setup and runtime"
```

---

### Task 4: Add the target-scoped macOS desktop driver

**Files:**
- Create: `apps/server/src/services/desktop-driver/types.ts`
- Create: `apps/server/src/services/desktop-driver/macos.ts`
- Create: `apps/server/src/services/desktop-driver/session.ts`
- Create: `apps/server/src/services/desktop-driver/session.test.ts`
- Create: `apps/server/src/routes/agent-desktop.ts`
- Create: `apps/server/src/routes/agent-desktop.test.ts`
- Create: `scripts/vpa-desktop-driver.mjs`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Produces `DesktopDriverSessionManager.create`, `.inspect`, `.screenshot`, `.act`, and `.revoke`.
- Produces bearer-protected loopback routes used only by `scripts/vpa-desktop-driver.mjs`.
- Produces the exact CLI commands embedded in Codex rehearsal prompts.

- [ ] **Step 1: Define the restricted driver contract**

Use operation types:

```ts
type DesktopDriverAction =
  | { kind: 'click'; elementIndex: number }
  | { kind: 'set-value'; elementIndex: number; value: string }
  | { kind: 'type-text'; value: string }
  | { kind: 'press-key'; key: 'Tab' | 'Return' | 'Escape' | 'Left' | 'Right' | 'Up' | 'Down' | 'space' };
```

Do not accept an application identifier or arbitrary path in action requests. Resolve the target once when creating the session.

- [ ] **Step 2: Implement macOS inspect/action/screenshot primitives**

Use fixed checked-in JXA strings or a fixed checked-in JXA resource invoked with `/usr/bin/osascript -l JavaScript`. Pass dynamic values through JSON stdin or environment, not executable source interpolation.

`inspect` returns at most 500 visible/actionable elements with fresh sequential indexes, role, title, value summary, enabled state, actions, and window bounds. Redact values for secure text fields.

Use `/usr/sbin/screencapture` or the available system path to capture only the resolved window to the session temp directory. Return an absolute PNG path.

- [ ] **Step 3: Enforce capabilities and stale indexes**

Generate a 256-bit random token, store only its SHA-256 hash, bind it to session/target/operations/expiry, and use timing-safe comparison. Reject excluded bundle IDs/display names, expired/revoked tokens, wrong sessions, disallowed keys, oversized text, and indexes from a previous snapshot generation.

- [ ] **Step 4: Add the loopback API and CLI client**

Expose routes under `/internal/agent-recording/driver/:sessionId` for inspect, screenshot, and action. Require the header value constructed as `` `Bearer ${token}` `` on every request and return no CORS-specific relaxation.

The client syntax is fixed:

```bash
node scripts/vpa-desktop-driver.mjs inspect
node scripts/vpa-desktop-driver.mjs screenshot
node scripts/vpa-desktop-driver.mjs click --element 12
node scripts/vpa-desktop-driver.mjs set-value --element 8 --value "fixture text"
node scripts/vpa-desktop-driver.mjs press-key --key Right
```

It reads base URL, session ID, and token only from child-process environment variables and never prints the token.

- [ ] **Step 5: Test the security boundary**

With a fake platform adapter, prove one target works and every excluded/other target fails; stale indexes fail; secure fields are redacted; key/text limits apply; token comparison is required; revoke deletes screenshots; route diagnostics never echo the token.

- [ ] **Step 6: Run the desktop-driver milestone tests**

```bash
npm test -w @vpa/server -- src/services/desktop-driver/session.test.ts src/routes/agent-desktop.test.ts
npm run typecheck -w @vpa/server
node scripts/vpa-desktop-driver.mjs --help
```

- [ ] **Step 7: Commit the driver**

```bash
git add apps/server/src/services/desktop-driver apps/server/src/routes/agent-desktop.ts apps/server/src/routes/agent-desktop.test.ts scripts/vpa-desktop-driver.mjs apps/server/src/server.ts
git commit -m "feat: add scoped macOS scene driver"
```

---

### Task 5: Build the server-owned recording coordinator

**Files:**
- Create: `apps/server/src/services/agent-recording/coordinator.ts`
- Create: `apps/server/src/services/agent-recording/coordinator.test.ts`
- Modify: `apps/server/src/services/agent-recording/session.ts`
- Modify: `apps/server/src/routes/recordings.ts`
- Modify: `apps/server/src/routes/recordings.test.ts`

**Interfaces:**
- Consumes `CapRuntime`, `CodexSceneRunner`, `DesktopDriverSessionManager`, project/storyboard services, metadata probing, and `ingestRecording`.
- Produces `rehearse`, `confirmAndRecord`, `cancel`, and `reconcile`.
- Keeps all Cap/Codex/local-path fields private.

- [ ] **Step 1: Define dependency injection and lifecycle entry points**

Use:

```ts
export interface AgentRecordingCoordinatorDeps {
  cap: CapRuntime;
  codex: CodexSceneRunner;
  desktop: DesktopDriverSessionManager;
  store: ProjectStore;
  workspaceRoot: string;
  probeVideo: typeof probe;
  ingest: typeof ingestRecording;
  now?: () => Date;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface AgentRecordingCoordinator {
  rehearse(projectId: string, sceneId: string, update: AgentRecordingPlanUpdate): Promise<AgentRecordingSession>;
  confirmAndRecord(projectId: string, sceneId: string, sessionId: string, input: AgentRecordingConfirmRequest): Promise<AgentRecordingSession>;
  cancel(projectId: string, sceneId: string, sessionId: string): Promise<AgentRecordingSession>;
  reconcile(): Promise<void>;
}
```

Route calls must return after scheduling background work; per-scene in-memory mutexes reject duplicate work.

- [ ] **Step 2: Implement rehearsal orchestration**

The background rehearsal must:

1. save and fingerprint the plan;
2. require macOS, supported scene/target, Cap ready, and unique Cap target;
3. create a `rehearsing` session;
4. create the desktop capability bound to that session ID;
5. call Codex with the plan embedded plus exact helper commands/env;
6. compare returned target/window evidence with a final independent driver inspect;
7. require all steps, checkpoints, and reset;
8. persist thread ID/evidence and transition to `awaiting_confirmation`;
9. fail and revoke the driver on any uncertainty.

- [ ] **Step 3: Implement confirmed capture through attachment**

Before capture, re-read the plan and compare `planFingerprint`; re-run doctor/targets; then:

```ts
const started = await cap.startRecording(capture);
await sessionStore.persistRecordingIdentity(sessionId, started);
await transition(sessionId, 'recording');
await delay(leadInMs, signal);
const evidence = await codex.resumeForRecording(threadId, prompt, env, signal);
await delay(tailMs, signal);
const stopped = await cap.stopRecording(started.recordingId);
await transition(sessionId, 'exporting');
await cap.validateProject(stopped.projectPath);
await cap.exportProject(stopped.projectPath, exportPath, signal);
await transition(sessionId, 'attaching');
const metadata = await probeVideo(exportPath);
await ingest(projectPath, sceneId, exportPath, metadata, provenance);
await transition(sessionId, 'completed');
```

Do not delete Cap project/export paths until ingestion and public scene metadata are verified.

- [ ] **Step 4: Implement failure, cancellation, and restart behavior**

Centralize failure handling. If a recording ID exists, attempt exact-ID stop once; never start another recording to recover. Revoke the driver and delete screenshots for every terminal state. Preserve only verified Cap/export paths needed for explicit retry.

On restart, mark rehearsal/recording sessions interrupted after best-effort stop. Leave exporting/attaching sessions recoverable and surface precise retry availability without auto-running them.

- [ ] **Step 5: Keep provenance ingestion compatible**

Coordinator calls `ingestRecording` directly with:

```ts
{
  source_kind: 'cap-agent',
  capture_session_id: session.id,
  captured_at: capturedAt,
}
```

Retain the multipart provenance checks for troubleshooting/manual agent uploads, but update tests for the `awaiting_confirmation` transition.

- [ ] **Step 6: Test complete fake-backed lifecycles**

Cover successful rehearsal; target mismatch; stale plan; confirmation without awaiting state; exact start/stop ID; Codex failure after start; stop metadata missing; validation failure; export failure; attachment failure; cancellation before/after start; duplicate scene run; restart reconciliation; successful provenance and public metadata.

- [ ] **Step 7: Run the coordinator milestone tests**

```bash
npm test -w @vpa/server -- src/services/agent-recording/coordinator.test.ts src/services/agent-recording/session.test.ts src/routes/recordings.test.ts
npm run typecheck -w @vpa/server
```

- [ ] **Step 8: Commit coordination**

```bash
git add apps/server/src/services/agent-recording apps/server/src/routes/recordings.ts apps/server/src/routes/recordings.test.ts
git commit -m "feat: coordinate rehearsed Cap scene recording"
```

---

### Task 6: Expose safe rehearsal, confirmation, and cancellation routes

**Files:**
- Modify: `apps/server/src/routes/agent-recording.ts`
- Modify: `apps/server/src/routes/agent-recording.test.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Produces the reviewed scene API from the design.
- Consumes coordinator methods from Task 5.
- Removes browser authority over arbitrary session transitions.

- [ ] **Step 1: Replace session mutation endpoints**

Keep plan GET/PUT and current-session GET. Remove public POST session creation and PATCH transition handlers. Add:

```ts
POST /api/projects/:id/scenes/:sceneId/agent-recording/rehearse
POST /api/projects/:id/scenes/:sceneId/agent-recording/sessions/:sessionId/confirm
POST /api/projects/:id/scenes/:sceneId/agent-recording/sessions/:sessionId/cancel
```

Parse all bodies with shared Zod schemas. Return `202` for scheduled rehearsal/recording, `200` for completed cancellation request processing, `409` for active/stale/illegal state, `400` for invalid plan/confirmation, and `404` for missing project/scene/session.

- [ ] **Step 2: Wire singleton dependencies in `buildServer()`**

Construct one Cap runtime, installer, desktop manager, Codex runner, and coordinator. Pass the same coordinator to routes so per-scene locks and child-process tracking are not duplicated. Call `coordinator.reconcile()` after stores are ready and before listening; log failures without preventing unrelated VPA features from starting.

- [ ] **Step 3: Update route tests**

Inject a fake coordinator and prove request parsing, status codes, exact project/scene/session forwarding, removed PATCH route (`404`), and that plan display alone never creates a session.

- [ ] **Step 4: Run route/server tests**

```bash
npm test -w @vpa/server -- src/routes/agent-recording.test.ts src/routes/setup.test.ts src/routes/recordings.test.ts
npm run typecheck -w @vpa/server
```

- [ ] **Step 5: Commit routes**

```bash
git add apps/server/src/routes/agent-recording.ts apps/server/src/routes/agent-recording.test.ts apps/server/src/server.ts
git commit -m "feat: expose direct agent recording controls"
```

---

### Task 7: Replace clipboard handoff with the in-VPA Cap workflow

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Rewrite: `apps/web/src/components/AgentRecordingDialog.tsx`
- Modify: `apps/web/src/components/AgentRecordingStatus.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/pages/ScenePage.tsx`

**Interfaces:**
- Consumes Cap setup and coordinator APIs from Tasks 3 and 6.
- Produces a nontechnical setup/rehearsal/confirmation/recording experience.

- [ ] **Step 1: Add typed web API methods**

Add:

```ts
capSetupApi.status(): Promise<CapSetupStatus>;
capSetupApi.check(): Promise<CapSetupStatus>;
capSetupApi.install(): Promise<{ installationId: string; state: 'installing' }>;
agentRecordingApi.rehearse(projectId, sceneId, update): Promise<AgentRecordingSession>;
agentRecordingApi.confirm(projectId, sceneId, sessionId, planFingerprint): Promise<AgentRecordingSession>;
agentRecordingApi.cancel(projectId, sceneId, sessionId): Promise<AgentRecordingSession>;
```

Remove client methods for create-session and arbitrary update-session.

- [ ] **Step 2: Build the Cap setup panel**

When the dialog opens, query Cap status. Render exact states and actions from the spec. **Install Cap** opens a confirmation sheet stating:

> VPA will download Cap Desktop from cap.so, install its command-line tool under VPA's local data folder, and leave your shell profile unchanged. macOS may ask you to approve the app and screen-recording permissions.

Only the confirmation button calls `install()`. Poll status every two seconds only while installing.

- [ ] **Step 3: Replace copy with direct rehearsal**

Save edited settings and call `rehearse`. Disable edits while a nonterminal session is active. Show phases: checking Cap, checking permissions, launching Codex, rehearsing actions, verifying reset.

Keep **Copy instructions** in a secondary troubleshooting menu using the existing clipboard logic. Keep **Upload manually** visible.

- [ ] **Step 4: Render the confirmation boundary**

For `awaiting_confirmation`, show the actual application/window/bounds, requested output dimensions/fps, capture toggles, action results, checkpoint results, and reset status. The primary action is **Confirm & record**; secondary actions are **Rehearse again**, **Cancel**, and **Upload manually**.

The confirmation mutation sends the exact session `planFingerprint`, preventing confirmation of changed settings.

- [ ] **Step 5: Render active, terminal, and cancel states**

Update status labels:

```ts
{
  rehearsing: 'Codex is rehearsing',
  awaiting_confirmation: 'Ready for your recording confirmation',
  recording: 'Recording this scene with Cap',
  exporting: 'Validating and exporting the take',
  attaching: 'Attaching the recording',
  completed: 'Recording attached',
  failed: 'Recording stopped',
  interrupted: 'Recording interrupted',
}
```

Show **Stop** for every nonterminal session. On completion invalidate storyboard, workflow status, scene recording, and current-session queries before closing.

- [ ] **Step 6: Add focused component tests if a component test harness exists; otherwise cover via E2E in Task 8**

Do not introduce a new browser-test library solely for this dialog. Typecheck and rely on Playwright route fakes for rendered behavior.

- [ ] **Step 7: Run the web milestone checks**

```bash
npm run typecheck -w @vpa/web
npm run build -w @vpa/web
npm run lint -- --quiet apps/web/src/components/AgentRecordingDialog.tsx apps/web/src/components/AgentRecordingStatus.tsx apps/web/src/pages/ScenePage.tsx apps/web/src/lib/api.ts
```

- [ ] **Step 8: Commit the UI**

```bash
git add apps/web/src/lib/api.ts apps/web/src/components/AgentRecordingDialog.tsx apps/web/src/components/AgentRecordingStatus.tsx apps/web/src/pages/ScenePage.tsx apps/web/src/styles.css
git commit -m "feat: run Cap recordings directly from VPA"
```

---

### Task 8: Update workflow contracts, documentation, and E2E coverage

**Files:**
- Modify: `.agents/skills/vpa-agent-recording/SKILL.md`
- Modify: `.agents/skills/vpa-agent-recording/references/handoff-template.md`
- Modify: `scripts/check-agent-recording-skill.mjs`
- Create: `tests/e2e/agent-recording.spec.ts`
- Modify: `docs/agent-recording-cap.md`
- Modify: `docs/superpowers/specs/2026-07-31-cap-agent-recording-design.md`

**Interfaces:**
- Codex skill now instructs the agent to use only VPA's desktop-driver client and structured evidence contract.
- E2E fakes model Cap status and asynchronous recording sessions without local installation.

- [ ] **Step 1: Rewrite the repository skill around VPA ownership**

Require Codex to:

1. use the plan embedded by VPA;
2. use only `scripts/vpa-desktop-driver.mjs` for GUI operations;
3. never run `cap`, upload, attach, change VPA session state, or operate another app;
4. rehearse, reset, and return the exact JSON evidence schema;
5. on resumed recording, execute only the rehearsed actions and return execution evidence.

Keep the handoff template solely for troubleshooting and label it as non-primary.

- [ ] **Step 2: Strengthen the skill contract checker**

Assert required direct-driver language and reject obsolete phrases that assign `cap record`, export, upload, or session PATCH responsibility to Codex.

- [ ] **Step 3: Add fake-backed Playwright coverage**

Intercept local APIs and cover:

- missing Cap -> setup panel -> install confirmation -> installing -> ready;
- direct rehearsal uses POST and never writes the clipboard;
- awaiting confirmation renders verified target/settings;
- no confirm request is sent before the user clicks;
- confirm -> recording -> exporting -> attaching -> completed;
- stale plan and rehearsal failure diagnostics;
- cancel action and manual upload remain available.

Use a minimal storyboard/project fixture and existing E2E helpers. Do not depend on real Cap, Codex, macOS permissions, or MeetingNotes.

- [ ] **Step 4: Update user documentation and supersession note**

Document the installed-runtime boundary, VPA-managed CLI shim, one-click setup, direct Codex dispatch, permission handoff, confirmation, local-only behavior, fallback actions, and the unverified-real-acceptance disclaimer. Add a short note to the earlier Cap design that the new design supersedes its clipboard/Computer Use sections.

- [ ] **Step 5: Run contract and E2E milestone checks**

```bash
npm run check:agent-recording-skill
npm run e2e -- tests/e2e/agent-recording.spec.ts
npm run typecheck
```

- [ ] **Step 6: Commit docs and E2E coverage**

```bash
git add .agents/skills/vpa-agent-recording scripts/check-agent-recording-skill.mjs tests/e2e/agent-recording.spec.ts docs/agent-recording-cap.md docs/superpowers/specs/2026-07-31-cap-agent-recording-design.md
git commit -m "test: verify direct Cap recording workflow"
```

---

### Task 9: Full verification and real macOS acceptance gate

**Files:**
- Modify only files required to correct failures found by verification.
- Do not commit generated Cap projects, MP4s, screenshots, setup state, or credentials.

**Interfaces:**
- Verifies every package, the built application, fake-backed E2E, and the real external workflow separately.

- [ ] **Step 1: Run the full automated suite once**

```bash
npm test
npm run typecheck
npm run build
npm run lint
npm run check:agent-recording-skill
npm run e2e
```

Expected: all tests pass, all workspaces typecheck/build, lint has zero warnings, and all Playwright specs pass.

- [ ] **Step 2: Review the final diff and repository state**

```bash
git diff --check
git status --short
git log --oneline -12
```

Confirm no generated media, tokens, Cap setup files, temp screenshots, or unrelated user changes are staged.

- [ ] **Step 3: Start VPA and perform setup readiness checks**

Run the development app. In the scene dialog, verify the current Mac initially reports Cap's real state rather than a fabricated fake. If Cap is absent, use the UI's explicit **Install Cap** confirmation; this is an external machine change and must not be triggered by an automated test.

Verify the resulting absolute CLI path, `version --json`, `guide --json`, `doctor --json`, and `targets --json`. Complete macOS privacy prompts manually.

- [ ] **Step 4: Perform the explicit MeetingNotes acceptance run**

For project `dd2553cb-8967-4a4e-a1a2-6d9bcedca00f`, scene `scene-01`:

1. rehearse Settings through General, Model, and Integration;
2. verify VPA displays MeetingNotes, the exact window, 1920×1080, 30 fps, cursor on, and all audio/camera inputs off;
3. verify Cap is not recording before confirmation;
4. explicitly choose **Confirm & record**;
5. verify the exact Cap recording stops with metadata, validates, exports, and attaches;
6. verify `scene-01` metadata has `source_kind: cap-agent` and the current session is `completed`;
7. verify no Cap Cloud item or share URL was created.

If any real external prerequisite prevents this run, report the exact unverified boundary. Do not claim real acceptance from fake-backed tests.

- [ ] **Step 5: Re-run the owning milestone after any verification correction**

If verification exposes a defect, return to the task that owns that file, make the minimal correction there, rerun that task's targeted command, then rerun Step 1 in full. Add the corrected file to that task's existing commit if it has not been reviewed yet; otherwise create a narrowly scoped `fix:` commit naming the corrected behavior. Do not use a broad staging command.

- [ ] **Step 6: Hand off the completed branch**

Report automated results and real acceptance results separately, including Cap version, target, exported/attached scene, and any permission/setup caveats. Then use the finishing-development-branch workflow to offer merge, push/PR, keep, or discard options.

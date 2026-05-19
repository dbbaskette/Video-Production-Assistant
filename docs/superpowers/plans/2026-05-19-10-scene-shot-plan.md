# Plan 10 — Scene Shot Plan (Optional Operator Script)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional per-scene **Shot Plan** step between storyboard approval and recording upload — an AI-generated, chat-refined, numbered list of recording instructions that the user follows while capturing the scene.

**Architecture:** Mirror the proven Ideation pattern. A new `services/shot-plan/` module manages per-`(projectId,sceneId)` in-memory chat sessions. Four scene-scoped routes (`GET`, `POST /message`, `POST /accept`, `DELETE`) plus one `POST /evict` for non-destructive Cancel. Accepted plans persist to `storyboard.yaml` as two new optional `SceneSchema` fields: `shot_plan` (the numbered steps) and `shot_plan_chat` (the transcript, for resume). UI is a new `ShotPlanSection` rendered above `RecordingUpload` on the Recording tab of `ScenePage`, plus two print views.

**Tech Stack:** TypeScript, Node 20+, Fastify, zod, Vitest, React 18, react-router-dom v6, @tanstack/react-query, Playwright.

**Spec reference:** `docs/superpowers/specs/2026-05-19-scene-shot-plan-design.md`.

**Risks:**
- Per-scene session sprawl in memory. v1 has no LRU cap; risk is bounded because sessions are small (transcript strings + array of step objects). Revisit if `ShotPlanManager` exceeds ~100 sessions in real use.
- LLM granularity drift: model can only produce truly literal keystrokes if the user feeds in specifics via chat. This is by design; the empty-state helper text sets expectations.
- `shot_plan_chat` lives in `storyboard.yaml`. Long transcripts make the YAML noisy but not broken. No mitigation in v1.

---

## File Structure

**Shared (modify):**
- `packages/shared/src/storyboard.ts` — extend `SceneSchema` with optional `shot_plan` + `shot_plan_chat`.

**Server (new):**
- `apps/server/src/services/shot-plan/index.ts` — `ShotPlanSession`, `ShotPlanManager`, `parseStepsFromResponse`, prompt assembly, `sendMessage`.
- `apps/server/src/services/shot-plan/index.test.ts`
- `apps/server/src/routes/shot-plan.ts` — register routes.
- `apps/server/src/routes/shot-plan.test.ts`
- `prompts/scene-shot-plan.md` — system prompt for the LLM.

**Server (modify):**
- `apps/server/src/server.ts` — instantiate `ShotPlanManager`, register `shot-plan` routes.
- `apps/server/src/services/llm/fake.ts` — add `isShotPlanPrompt` + canned response so dev/test mode produces parseable JSON.

**Web (new):**
- `apps/web/src/lib/parse-json-block.ts` — extracted from `Ideation.tsx` (also has a server analogue we keep duplicated; this util is web-side only).
- `apps/web/src/components/ShotPlanSection.tsx` — three-state section component.
- `apps/web/src/pages/ShotPlanPrintView.tsx` — per-scene print view.
- `apps/web/src/pages/ShotPlanProjectPrintView.tsx` — project-wide runbook.

**Web (modify):**
- `apps/web/src/lib/api.ts` — add `shotPlanApi` and supporting types.
- `apps/web/src/pages/ScenePage.tsx` — render `ShotPlanSection` above `RecordingUpload` in the Recording tab.
- `apps/web/src/App.tsx` — add the two print routes.
- `apps/web/src/components/StoryboardPreview.tsx` — passive checklist glyph when `scene.shot_plan` is present.

**E2E (new):**
- `tests/e2e/shot-plan.spec.ts`

---

## Task 1: Extend `SceneSchema` with shot_plan fields

**Files:**
- Test: `packages/shared/src/storyboard.test.ts` (extend existing tests if the file exists; otherwise add new cases — verify with `ls packages/shared/src/`)
- Modify: `packages/shared/src/storyboard.ts`

- [ ] **Step 1: Confirm test file location**

Run: `ls packages/shared/src/storyboard.test.ts 2>/dev/null && echo exists || echo missing`

If missing, create `packages/shared/src/storyboard.test.ts` with a minimal scaffold:

```ts
import { describe, it, expect } from 'vitest';
import { SceneSchema, StoryboardSchema } from './storyboard.js';

describe('SceneSchema', () => {
  // shot_plan tests will be added next
});
```

- [ ] **Step 2: Write failing tests for the new optional fields**

Append to `packages/shared/src/storyboard.test.ts`:

```ts
describe('SceneSchema shot_plan additions', () => {
  it('parses a scene without shot_plan (backwards compatible)', () => {
    const result = SceneSchema.safeParse({
      id: 's1',
      name: 'Intro',
      description: 'Opening shot',
      type: 'desktop',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shot_plan).toBeUndefined();
      expect(result.data.shot_plan_chat).toBeUndefined();
    }
  });

  it('parses a scene with a valid shot_plan array', () => {
    const result = SceneSchema.safeParse({
      id: 's1',
      name: 'Intro',
      description: 'Opening shot',
      type: 'desktop',
      shot_plan: [
        { index: 1, action: 'Open Terminal' },
        { index: 2, action: 'Type `npm run dev`', note: 'Wait for "ready"' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shot_plan).toHaveLength(2);
      expect(result.data.shot_plan?.[1]?.note).toBe('Wait for "ready"');
    }
  });

  it('rejects shot_plan steps with empty action', () => {
    const result = SceneSchema.safeParse({
      id: 's1',
      name: 'Intro',
      description: 'd',
      type: 'desktop',
      shot_plan: [{ index: 0, action: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('parses a scene with shot_plan_chat transcript', () => {
    const result = SceneSchema.safeParse({
      id: 's1',
      name: 'Intro',
      description: 'd',
      type: 'desktop',
      shot_plan_chat: [
        { role: 'user', content: 'Plan the recording', at: '2026-05-19T12:00:00.000Z' },
        { role: 'assistant', content: 'Step 1...', at: '2026-05-19T12:00:01.000Z' },
      ],
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

Run: `npm run test --workspace=@vpa/shared -- storyboard`
Expected: FAIL — `shot_plan` and `shot_plan_chat` not recognized; "unrecognized key" or shape mismatch.

- [ ] **Step 4: Add the fields to `SceneSchema`**

Edit `packages/shared/src/storyboard.ts`. In `SceneSchema` (after the existing `frame_render` field, before the closing `})`), add:

```ts
  /**
   * Optional per-scene operator script — a numbered list of recording instructions
   * the user follows while capturing the scene. Generated and refined via the
   * shot-plan chat. Absent for scenes the user did not opt in to plan.
   */
  shot_plan: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        action: z.string().min(1),
        note: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * Persisted chat transcript from the shot-plan session that produced
   * `shot_plan`. Kept so the user can resume refinement after the in-memory
   * session has been dropped (server restart, eviction, etc.).
   */
  shot_plan_chat: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
        at: z.string().datetime(),
      }),
    )
    .optional(),
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npm run test --workspace=@vpa/shared -- storyboard`
Expected: PASS — all four `shot_plan` cases.

- [ ] **Step 6: Build shared package**

Run: `npm run build --workspace=@vpa/shared`
Expected: clean build, no TS errors.

- [ ] **Step 7: Server-side typecheck still passes**

Run: `npm run typecheck --workspace=@vpa/server`
Expected: clean — existing server code does not reference the new fields, so it should keep compiling.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/storyboard.ts packages/shared/src/storyboard.test.ts
git commit -m "feat(shared): add optional shot_plan + shot_plan_chat to SceneSchema"
```

---

## Task 2: Extract JSON-block parser to a shared web util

The web Ideation page currently has no inline JSON parsing (the server does it), but the shot-plan UI needs to display proposedSteps that the *server* returns. So this task is small — we'll introduce a tiny `parse-json-block.ts` util now that's used in Task 7's API client to coerce the server response shape. (We are *not* refactoring Ideation in this task — it doesn't currently parse JSON itself.)

**Files:**
- Create: `apps/web/src/lib/parse-json-block.ts`
- Test: `apps/web/src/lib/parse-json-block.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/parse-json-block.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseJsonBlock } from './parse-json-block.js';

describe('parseJsonBlock', () => {
  it('returns the parsed object from a fenced ```json block', () => {
    const text = 'preamble\n```json\n{"a":1}\n```\nepilogue';
    expect(parseJsonBlock<{ a: number }>(text)).toEqual({ a: 1 });
  });

  it('returns null when there is no fenced block', () => {
    expect(parseJsonBlock('plain text')).toBeNull();
  });

  it('returns null for malformed JSON inside the block', () => {
    expect(parseJsonBlock('```json\n{not valid\n```')).toBeNull();
  });

  it('returns the first match when multiple blocks are present', () => {
    const text = '```json\n{"first":true}\n```\nthen\n```json\n{"second":true}\n```';
    expect(parseJsonBlock<{ first: boolean }>(text)).toEqual({ first: true });
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npm run test --workspace=@vpa/web -- parse-json-block`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the util**

Create `apps/web/src/lib/parse-json-block.ts`:

```ts
/**
 * Extract the first ```json fenced block from `text` and JSON.parse it.
 * Returns null if no block is present or the JSON is malformed.
 */
export function parseJsonBlock<T = unknown>(text: string): T | null {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m || !m[1]) return null;
  try {
    return JSON.parse(m[1].trim()) as T;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `npm run test --workspace=@vpa/web -- parse-json-block`
Expected: PASS — all four cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/parse-json-block.ts apps/web/src/lib/parse-json-block.test.ts
git commit -m "feat(web): add parse-json-block util for fenced LLM responses"
```

---

## Task 3: Author the shot-plan system prompt

**Files:**
- Create: `prompts/scene-shot-plan.md`

This is a content task — no test, just a commit.

- [ ] **Step 1: Create the prompt file**

Create `prompts/scene-shot-plan.md` with this exact body:

```markdown
You are the Shot Plan author for the Video Production Assistant. Your job is to produce a precise, step-by-step recording script for a single scene the user is about to record themselves.

## Your role

The user has an approved storyboard scene and is asking for a literal, "do exactly this" operator script: which apps to open, which keys to press, which URLs to visit, in what order. The script is for the *recorder* (the user) — not for the *viewer*.

Be specific. Prefer concrete commands, exact URLs, and literal keystrokes. When you do not know the specifics, write the step at the closest reasonable level of detail and *ask the user in your conversational reply* for the missing information so the next iteration can be more precise.

## Response shape

Always reply with a short conversational paragraph followed by a fenced JSON block.

The JSON block has this shape:

\`\`\`json
{"steps": [
  {"index": 1, "action": "Open a new Terminal window", "note": "Position next to your editor"},
  {"index": 2, "action": "Type `npm run dev` and press Enter"},
  {"index": 3, "action": "Wait for the dev server to print 'ready on http://localhost:5173'"}
]}
\`\`\`

Required fields per step:
- `index` — 1-based ordinal.
- `action` — a single observable action (open / click / type / press / wait / observe / show).

Optional:
- `note` — expected result, anchor, or "wait until …" hint. Use sparingly; omit when the action is self-evident.

## Guidelines

- One observable action per step. Split "type the command and press Enter" into one step only if the typing is itself worth observing; otherwise combine.
- Use backticks around literal commands, file paths, and URLs.
- Keep step text short. A step is something the user reads while their hands are on a keyboard.
- Number from 1 and increment without gaps.
- 5–15 steps is the sweet spot for a 30–90 second scene. Longer is fine for complex scenes; if you are about to exceed ~25 steps, mention in the conversational reply that the scene might benefit from being split.
- When the user supplies new information ("the URL is X", "use the install command from the README"), rewrite the affected steps and return the *full* updated list.
- If the user asks for a clarification or a meta change ("make it more concise", "drop the verification steps"), still return the full list — never partial.

## What you do *not* do

- You do not write the narration script — that is a different feature.
- You do not pick lower thirds — that is a different feature.
- You do not predict timing — durations are out of scope.

The conversational portion of your reply is shown verbatim to the user. The JSON block is parsed by the app and shown as a checklist.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/scene-shot-plan.md
git commit -m "feat(prompt): scene shot plan — operator script prompt"
```

---

## Task 4: Shot-plan service — session, manager, JSON parser (no LLM call)

**Files:**
- Create: `apps/server/src/services/shot-plan/index.ts`
- Test: `apps/server/src/services/shot-plan/index.test.ts`

- [ ] **Step 1: Write the failing test for `parseStepsFromResponse`**

Create `apps/server/src/services/shot-plan/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseStepsFromResponse,
  ShotPlanSession,
  ShotPlanManager,
  stripJsonBlock,
} from './index.js';

describe('parseStepsFromResponse', () => {
  it('extracts steps from a fenced JSON block', () => {
    const text =
      'Here is the plan:\n\n```json\n{"steps": [' +
      '{"index": 1, "action": "Open Terminal"},' +
      '{"index": 2, "action": "Type `npm run dev`", "note": "wait"}' +
      ']}\n```';
    const steps = parseStepsFromResponse(text);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ index: 1, action: 'Open Terminal' });
    expect(steps[1]).toEqual({ index: 2, action: 'Type `npm run dev`', note: 'wait' });
  });

  it('returns empty array when no JSON block is present', () => {
    expect(parseStepsFromResponse('just prose, no fence')).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    expect(parseStepsFromResponse('```json\n{nope\n```')).toEqual([]);
  });

  it('drops steps with empty action', () => {
    const text = '```json\n{"steps":[{"index":1,"action":""},{"index":2,"action":"OK"}]}\n```';
    const steps = parseStepsFromResponse(text);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.action).toBe('OK');
  });

  it('coerces missing index to 0-based ordinal', () => {
    const text = '```json\n{"steps":[{"action":"A"},{"action":"B"}]}\n```';
    const steps = parseStepsFromResponse(text);
    expect(steps).toEqual([
      { index: 1, action: 'A' },
      { index: 2, action: 'B' },
    ]);
  });
});

describe('stripJsonBlock', () => {
  it('removes the fenced block from the assistant text', () => {
    const text = 'hello\n```json\n{"x":1}\n```\nworld';
    expect(stripJsonBlock(text)).toBe('hello\n\nworld');
  });

  it('returns text unchanged when no block is present', () => {
    expect(stripJsonBlock('plain text')).toBe('plain text');
  });
});

describe('ShotPlanSession (state only)', () => {
  it('starts empty', () => {
    const s = new ShotPlanSession('p1', 'scene-01');
    expect(s.transcript).toEqual([]);
    expect(s.proposedSteps).toEqual([]);
  });

  it('hydrates transcript from a saved chat', () => {
    const s = new ShotPlanSession('p1', 'scene-01', [
      { role: 'user', content: 'hi', at: '2026-05-19T12:00:00.000Z' },
      { role: 'assistant', content: 'ok', at: '2026-05-19T12:00:01.000Z' },
    ]);
    expect(s.transcript).toHaveLength(2);
  });
});

describe('ShotPlanManager', () => {
  it('getOrCreate returns the same session for the same (project, scene)', () => {
    const m = new ShotPlanManager();
    const a = m.getOrCreate('p1', 'scene-01');
    const b = m.getOrCreate('p1', 'scene-01');
    expect(a).toBe(b);
  });

  it('getOrCreate returns different sessions for different scenes', () => {
    const m = new ShotPlanManager();
    const a = m.getOrCreate('p1', 'scene-01');
    const b = m.getOrCreate('p1', 'scene-02');
    expect(a).not.toBe(b);
  });

  it('get returns undefined when no session exists', () => {
    const m = new ShotPlanManager();
    expect(m.get('p1', 'scene-01')).toBeUndefined();
  });

  it('delete removes the session', () => {
    const m = new ShotPlanManager();
    m.getOrCreate('p1', 'scene-01');
    m.delete('p1', 'scene-01');
    expect(m.get('p1', 'scene-01')).toBeUndefined();
  });

  it('getOrCreate hydrates from a passed transcript only on first creation', () => {
    const m = new ShotPlanManager();
    const a = m.getOrCreate('p1', 'scene-01', [
      { role: 'user', content: 'first', at: '2026-05-19T12:00:00.000Z' },
    ]);
    expect(a.transcript).toHaveLength(1);
    // second call with a different transcript should not overwrite the existing session
    const b = m.getOrCreate('p1', 'scene-01', [
      { role: 'user', content: 'overwrite?', at: '2026-05-19T12:00:02.000Z' },
    ]);
    expect(b).toBe(a);
    expect(b.transcript).toHaveLength(1);
    expect(b.transcript[0]?.content).toBe('first');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npm run test --workspace=@vpa/server -- shot-plan`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service (state + parsing only — no LLM yet)**

Create `apps/server/src/services/shot-plan/index.ts`:

```ts
import { randomUUID } from 'node:crypto';

export interface ShotPlanStep {
  index: number;
  action: string;
  note?: string;
}

export interface ShotPlanChatTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

/**
 * Parse the steps array from an LLM reply.
 * Expects a fenced ```json block containing `{ "steps": [ { index, action, note? } ] }`.
 * Empty actions are dropped; missing indices are renumbered 1-based in order.
 */
export function parseStepsFromResponse(text: string): ShotPlanStep[] {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m || !m[1]) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1].trim());
  } catch {
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { steps?: unknown }).steps)
  ) {
    return [];
  }
  const raw = (parsed as { steps: unknown[] }).steps;
  const cleaned: ShotPlanStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const obj = s as Record<string, unknown>;
    const action = typeof obj.action === 'string' ? obj.action.trim() : '';
    if (!action) continue;
    const note = typeof obj.note === 'string' && obj.note.trim() ? obj.note.trim() : undefined;
    const step: ShotPlanStep = { index: cleaned.length + 1, action };
    if (note !== undefined) step.note = note;
    cleaned.push(step);
  }
  // Renumber 1-based regardless of what the model emitted, so the UI never has gaps.
  return cleaned.map((s, i) => ({ ...s, index: i + 1 }));
}

/** Strip the JSON code fence from assistant text for clean display. */
export function stripJsonBlock(text: string): string {
  return text.replace(/```json\s*[\s\S]*?```/, '').trim();
}

/**
 * Single shot-plan conversation, scoped to one (projectId, sceneId).
 * State is in-memory only — for persistence across server restarts, the routes
 * write `scene.shot_plan_chat` to `storyboard.yaml` at accept time.
 */
export class ShotPlanSession {
  readonly projectId: string;
  readonly sceneId: string;
  transcript: ShotPlanChatTurn[] = [];
  proposedSteps: ShotPlanStep[] = [];

  constructor(
    projectId: string,
    sceneId: string,
    hydrateTranscript?: ShotPlanChatTurn[],
  ) {
    this.projectId = projectId;
    this.sceneId = sceneId;
    if (hydrateTranscript && hydrateTranscript.length > 0) {
      this.transcript = [...hydrateTranscript];
    }
  }

  /** Append a turn. The id is generated for future use (logging, references); not exposed. */
  appendTurn(role: 'user' | 'assistant', content: string): ShotPlanChatTurn {
    const turn: ShotPlanChatTurn = {
      role,
      content,
      at: new Date().toISOString(),
    };
    this.transcript.push(turn);
    // randomUUID call kept for parity with Ideation — not stored, just future-proofing.
    void randomUUID();
    return turn;
  }
}

/** Manager keyed by `${projectId}:${sceneId}`. */
export class ShotPlanManager {
  private sessions = new Map<string, ShotPlanSession>();

  private key(projectId: string, sceneId: string): string {
    return `${projectId}:${sceneId}`;
  }

  getOrCreate(
    projectId: string,
    sceneId: string,
    hydrateTranscript?: ShotPlanChatTurn[],
  ): ShotPlanSession {
    const k = this.key(projectId, sceneId);
    let s = this.sessions.get(k);
    if (!s) {
      s = new ShotPlanSession(projectId, sceneId, hydrateTranscript);
      this.sessions.set(k, s);
    }
    return s;
  }

  get(projectId: string, sceneId: string): ShotPlanSession | undefined {
    return this.sessions.get(this.key(projectId, sceneId));
  }

  delete(projectId: string, sceneId: string): void {
    this.sessions.delete(this.key(projectId, sceneId));
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `npm run test --workspace=@vpa/server -- shot-plan`
Expected: PASS — all parse + state cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/shot-plan/
git commit -m "feat(server): shot-plan session + manager + step parser"
```

---

## Task 5: Shot-plan service — `sendMessage` with the LLM

**Files:**
- Modify: `apps/server/src/services/shot-plan/index.ts`
- Modify: `apps/server/src/services/shot-plan/index.test.ts`
- Modify: `apps/server/src/services/llm/fake.ts`

- [ ] **Step 1: Teach the fake LLM about the shot-plan prompt**

Read the top of `apps/server/src/services/llm/fake.ts` to confirm the `isXxxPrompt` helper location, then add this helper near the other `isXxxPrompt` functions (around the existing `isQualityReviewPrompt`):

```ts
function isShotPlanPrompt(opts: LlmCompleteOptions): boolean {
  return opts.systemPrompt.toLowerCase().includes('shot plan author');
}
```

Inside the `createFakeLlm` factory's returned `complete` method, *before* the `isIdeationPrompt` branch, add:

```ts
      if (isShotPlanPrompt(opts)) {
        return {
          text:
            "Here's a first pass — tell me anything I should make more specific.\n\n" +
            '```json\n' +
            '{"steps":[' +
            '{"index":1,"action":"Open a new Terminal window"},' +
            '{"index":2,"action":"Type `npm run dev` and press Enter","note":"Wait for the ready line"},' +
            '{"index":3,"action":"Show the rendered page in the browser"}' +
            ']}\n' +
            '```',
        };
      }
```

- [ ] **Step 2: Add a sendMessage test (failing)**

Append to `apps/server/src/services/shot-plan/index.test.ts`:

```ts
import type { LlmClient } from '../llm/index.js';

const MOCK_LLM_TEXT =
  'Here is the plan:\n\n```json\n{"steps":[' +
  '{"index":1,"action":"Open Terminal"},' +
  '{"index":2,"action":"Type `npm run dev`","note":"wait"}' +
  ']}\n```\n\nAnything missing?';

const mockLlm: LlmClient = {
  async complete() {
    return { text: MOCK_LLM_TEXT };
  },
};

describe('ShotPlanSession.sendMessage', () => {
  it('appends user + assistant turns and updates proposedSteps', async () => {
    const s = new ShotPlanSession('p1', 'scene-01');
    const scene = {
      id: 'scene-01',
      name: 'Boot the dev server',
      description: 'Show the dev server starting',
      type: 'terminal' as const,
    };
    const project = { objective: 'Show how to run the app', audience: 'developers' };

    const reply = await s.sendMessage('Plan it', mockLlm, scene, project);

    expect(s.transcript).toHaveLength(2);
    expect(s.transcript[0]?.role).toBe('user');
    expect(s.transcript[0]?.content).toBe('Plan it');
    expect(s.transcript[1]?.role).toBe('assistant');

    expect(reply.role).toBe('assistant');
    expect(reply.content).not.toContain('```json');
    expect(reply.content).toContain('Anything missing?');

    expect(s.proposedSteps).toHaveLength(2);
    expect(s.proposedSteps[0]?.action).toBe('Open Terminal');
  });

  it('passes scene + project context into the LLM prompt', async () => {
    let captured = '';
    const captureLlm: LlmClient = {
      async complete(opts) {
        captured = `${opts.systemPrompt}\n---\n${opts.userPrompt}`;
        return { text: MOCK_LLM_TEXT };
      },
    };
    const s = new ShotPlanSession('p1', 'scene-01');
    const scene = {
      id: 'scene-01',
      name: 'Boot the dev server',
      description: 'Show the dev server starting',
      intent: 'demonstrate hot reload',
      type: 'terminal' as const,
    };
    const project = { objective: 'Show how to run the app', audience: 'developers' };

    await s.sendMessage('Plan it', captureLlm, scene, project);

    expect(captured).toContain('Shot Plan author');
    expect(captured).toContain('Boot the dev server');
    expect(captured).toContain('Show the dev server starting');
    expect(captured).toContain('demonstrate hot reload');
    expect(captured).toContain('Show how to run the app');
    expect(captured).toContain('developers');
  });

  it('leaves proposedSteps unchanged when the response has no JSON block', async () => {
    const noJsonLlm: LlmClient = {
      async complete() {
        return { text: 'just prose, no fence here' };
      },
    };
    const s = new ShotPlanSession('p1', 'scene-01');
    const scene = { id: 'scene-01', name: 'X', description: 'y', type: 'desktop' as const };

    await s.sendMessage('hi', noJsonLlm, scene, {});
    expect(s.proposedSteps).toEqual([]);
    expect(s.transcript).toHaveLength(2);
    expect(s.transcript[1]?.content).toBe('just prose, no fence here');
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

Run: `npm run test --workspace=@vpa/server -- shot-plan`
Expected: FAIL — `sendMessage` does not exist.

- [ ] **Step 4: Implement `sendMessage`**

Edit `apps/server/src/services/shot-plan/index.ts`. Add these imports near the top (next to `randomUUID`):

```ts
import { resolve } from 'node:path';
import type { Scene } from '@vpa/shared';
import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';
```

Add a workspace-root helper at module scope (mirror of Ideation's):

```ts
function workspaceRoot(): string {
  return resolve(import.meta.dirname, '../../../../..');
}
```

Inside `ShotPlanSession`, add the `sendMessage` method (place it below `appendTurn`):

```ts
  async sendMessage(
    content: string,
    llm: LlmClient,
    scene: Pick<Scene, 'id' | 'name' | 'description' | 'type'> & {
      intent?: string;
    },
    project: { objective?: string; audience?: string; sourceDocs?: string[] },
  ): Promise<ShotPlanChatTurn> {
    this.appendTurn('user', content);

    const systemPrompt = await loadPrompt(workspaceRoot(), 'scene-shot-plan');

    const sceneContext =
      `Scene name: ${scene.name}\n` +
      `Scene type: ${scene.type}\n` +
      `Scene description: ${scene.description}` +
      (scene.intent ? `\nUser intent: ${scene.intent}` : '');

    const projectContext =
      (project.objective ? `Project objective: ${project.objective}\n` : '') +
      (project.audience ? `Audience: ${project.audience}\n` : '') +
      (project.sourceDocs && project.sourceDocs.length > 0
        ? `Project source docs: ${project.sourceDocs.join(', ')}\n`
        : '');

    const historyContext = this.transcript
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n\n');

    const currentStepsContext =
      this.proposedSteps.length > 0
        ? `\n\nCurrent proposed steps:\n${JSON.stringify({ steps: this.proposedSteps }, null, 2)}`
        : '';

    const userPrompt =
      `${sceneContext}\n\n${projectContext}\nConversation:\n${historyContext}${currentStepsContext}`;

    const completion = await llm.complete({
      systemPrompt,
      userPrompt,
      temperature: 0.4,
    });

    const steps = parseStepsFromResponse(completion.text);
    if (steps.length > 0) {
      this.proposedSteps = steps;
    }

    return this.appendTurn('assistant', stripJsonBlock(completion.text));
  }
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npm run test --workspace=@vpa/server -- shot-plan`
Expected: PASS — all `sendMessage` cases plus the prior state/parse tests.

Also run the fake-llm test to confirm we didn't break it:

Run: `npm run test --workspace=@vpa/server -- llm/fake`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/shot-plan/ apps/server/src/services/llm/fake.ts
git commit -m "feat(server): shot-plan sendMessage + fake LLM canned response"
```

---

## Task 6: Routes — register the four+one endpoints

**Files:**
- Create: `apps/server/src/routes/shot-plan.ts`
- Test: `apps/server/src/routes/shot-plan.test.ts`
- Modify: `apps/server/src/server.ts`

- [ ] **Step 1: Write the failing route integration test**

Create `apps/server/src/routes/shot-plan.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectStore } from '../services/project/store.js';
import { ShotPlanManager } from '../services/shot-plan/index.js';
import { createFakeLlm } from '../services/llm/index.js';
import type { LlmClient } from '../services/llm/index.js';
import { saveStoryboard, createStoryboard, loadStoryboard } from '../services/storyboard/index.js';
import { registerShotPlanRoutes } from './shot-plan.js';

async function buildTestServer(opts: { llm?: LlmClient } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-sp-home-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-sp-projects-'));
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const llm = opts.llm ?? createFakeLlm();
  const shotPlanManager = new ShotPlanManager();
  const app = Fastify();
  await app.register(async (i) =>
    registerShotPlanRoutes(i, { store, llm, shotPlanManager }),
  );
  return { app, store, llm, shotPlanManager, home, projects };
}

async function seedProjectWithScene(
  store: ProjectStore,
  sceneId = 'scene-01',
): Promise<{ projectId: string; projectPath: string }> {
  const project = await store.create({ name: 'sp-test', objective: 'test demo' });
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === project.id)!;
  const sb = createStoryboard(
    {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      created: entry.lastOpened ?? new Date().toISOString(),
      brand: null,
    },
    [
      {
        id: sceneId,
        name: 'Boot the dev server',
        description: 'Show npm run dev starting',
        type: 'terminal',
      },
    ],
  );
  await saveStoryboard(entry.path, sb);
  return { projectId: project.id, projectPath: entry.path };
}

describe('shot-plan routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    ctx = await buildTestServer();
  });

  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET returns empty state for a fresh scene', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transcript).toEqual([]);
    expect(body.proposedSteps).toEqual([]);
    expect(body.savedPlan).toBeNull();
  });

  it('POST /message returns assistant reply with proposed steps', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply).toBeTruthy();
    expect(body.reply).not.toContain('```json');
    expect(body.proposedSteps.length).toBeGreaterThan(0);
    expect(body.proposedSteps[0].action).toBeTruthy();
  });

  it('GET after a message includes transcript and proposed steps from memory', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan`,
    });
    const body = res.json();
    expect(body.transcript).toHaveLength(2);
    expect(body.proposedSteps.length).toBeGreaterThan(0);
    expect(body.savedPlan).toBeNull();
  });

  it('POST /accept persists plan + transcript to storyboard.yaml', async () => {
    const { projectId, projectPath } = await seedProjectWithScene(ctx.store);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/accept`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shot_plan.length).toBeGreaterThan(0);
    expect(body.shot_plan_chat.length).toBe(2);

    const sb = await loadStoryboard(projectPath);
    const scene = sb!.scenes.find((s) => s.id === 'scene-01')!;
    expect(scene.shot_plan?.length).toBe(body.shot_plan.length);
    expect(scene.shot_plan_chat?.length).toBe(2);

    // accept clears the in-memory session
    expect(ctx.shotPlanManager.get(projectId, 'scene-01')).toBeUndefined();
  });

  it('POST /accept returns 400 when no proposedSteps exist', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    // Touching GET creates an empty session — accept must still 400.
    await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan`,
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/accept`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('no_steps');
  });

  it('DELETE clears persisted shot_plan and shot_plan_chat and the in-memory session', async () => {
    const { projectId, projectPath } = await seedProjectWithScene(ctx.store);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/accept`,
    });
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan`,
    });
    expect(res.statusCode).toBe(200);
    const sb = await loadStoryboard(projectPath);
    const scene = sb!.scenes.find((s) => s.id === 'scene-01')!;
    expect(scene.shot_plan).toBeUndefined();
    expect(scene.shot_plan_chat).toBeUndefined();
  });

  it('POST /evict drops only the in-memory session, never touches disk', async () => {
    const { projectId, projectPath } = await seedProjectWithScene(ctx.store);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/accept`,
    });
    // start a Refine: GET to hydrate, then send a message
    await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan`,
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'tighten it up' },
    });
    expect(ctx.shotPlanManager.get(projectId, 'scene-01')).toBeDefined();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/evict`,
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.shotPlanManager.get(projectId, 'scene-01')).toBeUndefined();

    // disk still has the previously accepted plan
    const sb = await loadStoryboard(projectPath);
    const scene = sb!.scenes.find((s) => s.id === 'scene-01')!;
    expect(scene.shot_plan?.length).toBeGreaterThan(0);
  });

  it('POST /message with empty content returns 400', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });

  it('returns 404 for an unknown project', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/does-not-exist/scenes/scene-01/shot-plan`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('project_not_found');
  });

  it('returns 404 for an unknown scene', async () => {
    const { projectId } = await seedProjectWithScene(ctx.store);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/scenes/unknown/shot-plan`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('scene_not_found');
  });

  it('returns 502 with code llm_error when the LLM throws', async () => {
    // Tear down the default-context server and build a fresh one with a throwing LLM
    // so we don't pollute the other tests.
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
    const throwingLlm: LlmClient = {
      async complete() {
        throw new Error('upstream is down');
      },
    };
    ctx = await buildTestServer({ llm: throwingLlm });
    const { projectId } = await seedProjectWithScene(ctx.store);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/scenes/scene-01/shot-plan/message`,
      payload: { content: 'Plan it' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('llm_error');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npm run test --workspace=@vpa/server -- routes/shot-plan`
Expected: FAIL — `./shot-plan.js` module missing.

- [ ] **Step 3: Implement the routes**

Create `apps/server/src/routes/shot-plan.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { ProjectStore } from '../services/project/store.js';
import type { LlmClient } from '../services/llm/index.js';
import {
  ShotPlanManager,
  type ShotPlanStep,
  type ShotPlanChatTurn,
} from '../services/shot-plan/index.js';
import {
  loadStoryboard,
  saveStoryboard,
  updateScene,
} from '../services/storyboard/index.js';

interface Deps {
  store: ProjectStore;
  llm: LlmClient;
  shotPlanManager: ShotPlanManager;
}

interface RouteParams {
  id: string;
  sceneId: string;
}

async function resolveProjectAndScene(
  store: ProjectStore,
  projectId: string,
  sceneId: string,
) {
  const tracker = await store.readTracker();
  const entry = tracker.projects.find((p) => p.id === projectId);
  if (!entry) {
    throw { statusCode: 404, code: 'project_not_found', message: `Project not found: ${projectId}` };
  }
  const sb = await loadStoryboard(entry.path);
  if (!sb) {
    throw { statusCode: 404, code: 'scene_not_found', message: `No storyboard yet for ${projectId}` };
  }
  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) {
    throw { statusCode: 404, code: 'scene_not_found', message: `Scene not found: ${sceneId}` };
  }
  return { entry, sb, scene };
}

export async function registerShotPlanRoutes(
  app: FastifyInstance,
  deps: Deps,
): Promise<void> {
  const { store, llm, shotPlanManager } = deps;

  // Fastify error handler — translate our thrown { statusCode, code, message } shape.
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.code) {
      reply.status(e.statusCode).send({ error: e.message ?? e.code, code: e.code });
      return;
    }
    reply.send(err);
  });

  // GET /api/projects/:id/scenes/:sceneId/shot-plan
  app.get('/api/projects/:id/scenes/:sceneId/shot-plan', async (req) => {
    const { id, sceneId } = req.params as RouteParams;
    const { scene } = await resolveProjectAndScene(store, id, sceneId);

    const session = shotPlanManager.get(id, sceneId);
    if (session) {
      return {
        transcript: session.transcript,
        proposedSteps: session.proposedSteps,
        savedPlan: scene.shot_plan ?? null,
      };
    }
    return {
      transcript: scene.shot_plan_chat ?? [],
      proposedSteps: [],
      savedPlan: scene.shot_plan ?? null,
    };
  });

  // POST /api/projects/:id/scenes/:sceneId/shot-plan/message
  app.post('/api/projects/:id/scenes/:sceneId/shot-plan/message', async (req, reply) => {
    const { id, sceneId } = req.params as RouteParams;
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content || typeof content !== 'string' || !content.trim()) {
      return reply.status(400).send({ error: 'content is required', code: 'invalid_request' });
    }
    const { sb, scene } = await resolveProjectAndScene(store, id, sceneId);
    const session = shotPlanManager.getOrCreate(id, sceneId, scene.shot_plan_chat ?? undefined);

    let assistantTurn;
    try {
      assistantTurn = await session.sendMessage(
        content.trim(),
        llm,
        {
          id: scene.id,
          name: scene.name,
          description: scene.description,
          type: scene.type,
          intent: scene.intent,
        },
        {
          objective: sb.project.objective,
          audience: sb.project.audience,
          sourceDocs: sb.project.source_docs ?? [],
        },
      );
    } catch (err) {
      req.log.error({ err }, 'shot-plan LLM call failed');
      return reply
        .status(502)
        .send({ error: err instanceof Error ? err.message : 'LLM call failed', code: 'llm_error' });
    }

    return {
      reply: assistantTurn.content,
      proposedSteps: session.proposedSteps,
    };
  });

  // POST /api/projects/:id/scenes/:sceneId/shot-plan/accept
  app.post('/api/projects/:id/scenes/:sceneId/shot-plan/accept', async (req, reply) => {
    const { id, sceneId } = req.params as RouteParams;
    const { entry, sb } = await resolveProjectAndScene(store, id, sceneId);

    const session = shotPlanManager.get(id, sceneId);
    if (!session || session.proposedSteps.length === 0) {
      return reply.status(400).send({ error: 'No steps to accept', code: 'no_steps' });
    }

    const shot_plan: ShotPlanStep[] = session.proposedSteps.map((s, i) => ({
      index: i + 1,
      action: s.action,
      ...(s.note ? { note: s.note } : {}),
    }));
    const shot_plan_chat: ShotPlanChatTurn[] = [...session.transcript];

    const updated = updateScene(sb, sceneId, { shot_plan, shot_plan_chat });
    await saveStoryboard(entry.path, updated);
    shotPlanManager.delete(id, sceneId);

    return updated.scenes.find((s) => s.id === sceneId);
  });

  // DELETE /api/projects/:id/scenes/:sceneId/shot-plan
  app.delete('/api/projects/:id/scenes/:sceneId/shot-plan', async (req) => {
    const { id, sceneId } = req.params as RouteParams;
    const { entry, sb } = await resolveProjectAndScene(store, id, sceneId);
    const updated = updateScene(sb, sceneId, {
      shot_plan: undefined,
      shot_plan_chat: undefined,
    });
    await saveStoryboard(entry.path, updated);
    shotPlanManager.delete(id, sceneId);
    return updated.scenes.find((s) => s.id === sceneId);
  });

  // POST /api/projects/:id/scenes/:sceneId/shot-plan/evict
  // Drops the in-memory session only — never touches disk. Used by the UI's
  // Cancel link in the Refine flow so the saved plan stays put.
  app.post('/api/projects/:id/scenes/:sceneId/shot-plan/evict', async (req) => {
    const { id, sceneId } = req.params as RouteParams;
    await resolveProjectAndScene(store, id, sceneId); // 404 if invalid
    shotPlanManager.delete(id, sceneId);
    return { evicted: true };
  });
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `npm run test --workspace=@vpa/server -- routes/shot-plan`
Expected: PASS — all 10 cases.

- [ ] **Step 5: Wire into `server.ts`**

Edit `apps/server/src/server.ts`. Add the imports near the other route + service imports:

```ts
import { registerShotPlanRoutes } from './routes/shot-plan.js';
import { ShotPlanManager } from './services/shot-plan/index.js';
```

After the line `const ideationManager = new IdeationManager();`, add:

```ts
  const shotPlanManager = new ShotPlanManager();
```

After the existing `registerIdeationRoutes` registration block, add:

```ts
  await app.register(async (instance) =>
    registerShotPlanRoutes(instance, { store, llm, shotPlanManager }),
  );
```

- [ ] **Step 6: Server typecheck + start smoke**

Run: `npm run typecheck --workspace=@vpa/server`
Expected: clean.

Run: `npm run --workspace=@vpa/server dev` for a moment, then Ctrl-C.
Expected: server starts, logs `vpa-server listening on …`, no errors at startup. (Optional manual smoke if you have a project: `curl http://localhost:3000/api/projects/<id>/scenes/<sceneId>/shot-plan`.)

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/shot-plan.ts apps/server/src/routes/shot-plan.test.ts apps/server/src/server.ts
git commit -m "feat(server): shot-plan routes + wire into server"
```

---

## Task 7: Web API client — `shotPlanApi`

**Files:**
- Modify: `apps/web/src/lib/api.ts`

This is a typed client. No test (it's a thin wrapper over `request`); covered indirectly by component and e2e tests.

- [ ] **Step 1: Add the types and client to `apps/web/src/lib/api.ts`**

Append at the bottom of the file (after `ideationApi`):

```ts
export interface ShotPlanStep {
  index: number;
  action: string;
  note?: string;
}

export interface ShotPlanChatTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface ShotPlanState {
  transcript: ShotPlanChatTurn[];
  proposedSteps: ShotPlanStep[];
  savedPlan: ShotPlanStep[] | null;
}

export interface ShotPlanMessageResponse {
  reply: string;
  proposedSteps: ShotPlanStep[];
}

export const shotPlanApi = {
  get(projectId: string, sceneId: string): Promise<ShotPlanState> {
    return request<ShotPlanState>(
      'GET',
      `/api/projects/${projectId}/scenes/${sceneId}/shot-plan`,
    );
  },
  sendMessage(
    projectId: string,
    sceneId: string,
    content: string,
  ): Promise<ShotPlanMessageResponse> {
    return request<ShotPlanMessageResponse>(
      'POST',
      `/api/projects/${projectId}/scenes/${sceneId}/shot-plan/message`,
      { content },
    );
  },
  accept(projectId: string, sceneId: string): Promise<Scene> {
    return request<Scene>(
      'POST',
      `/api/projects/${projectId}/scenes/${sceneId}/shot-plan/accept`,
    );
  },
  discard(projectId: string, sceneId: string): Promise<Scene> {
    return request<Scene>(
      'DELETE',
      `/api/projects/${projectId}/scenes/${sceneId}/shot-plan`,
    );
  },
  evict(projectId: string, sceneId: string): Promise<{ evicted: true }> {
    return request<{ evicted: true }>(
      'POST',
      `/api/projects/${projectId}/scenes/${sceneId}/shot-plan/evict`,
    );
  },
};
```

- [ ] **Step 2: Web typecheck**

Run: `npm run typecheck --workspace=@vpa/web`
Expected: clean. (`Scene` is already imported at the top of `api.ts`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): shotPlanApi client + types"
```

---

## Task 8: `ShotPlanSection` component

**Files:**
- Create: `apps/web/src/components/ShotPlanSection.tsx`

The whole section in one file — three view states, ~250 lines. No component test in this task (Vitest setup for React components is not present in this codebase; the e2e in Task 11 covers UI).

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/ShotPlanSection.tsx`:

```tsx
import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { shotPlanApi, type ShotPlanStep } from '../lib/api.js';
import { ChatMessage } from './ChatMessage.js';

type Mode = 'empty' | 'chat' | 'accepted';

interface Props {
  projectId: string;
  sceneId: string;
}

export function ShotPlanSection({ projectId, sceneId }: Props) {
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [refining, setRefining] = useState(false);
  const [localTicked, setLocalTicked] = useState<Set<number>>(new Set());
  const chatEndRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['shot-plan', projectId, sceneId],
    queryFn: () => shotPlanApi.get(projectId, sceneId),
  });

  const sendMutation = useMutation({
    mutationFn: (content: string) => shotPlanApi.sendMessage(projectId, sceneId, content),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shot-plan', projectId, sceneId] }),
  });

  const acceptMutation = useMutation({
    mutationFn: () => shotPlanApi.accept(projectId, sceneId),
    onSuccess: () => {
      setRefining(false);
      qc.invalidateQueries({ queryKey: ['shot-plan', projectId, sceneId] });
      qc.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  const discardMutation = useMutation({
    mutationFn: () => shotPlanApi.discard(projectId, sceneId),
    onSuccess: () => {
      setRefining(false);
      qc.invalidateQueries({ queryKey: ['shot-plan', projectId, sceneId] });
      qc.invalidateQueries({ queryKey: ['storyboard', projectId] });
    },
  });

  const evictMutation = useMutation({
    mutationFn: () => shotPlanApi.evict(projectId, sceneId),
    onSuccess: () => {
      setRefining(false);
      qc.invalidateQueries({ queryKey: ['shot-plan', projectId, sceneId] });
    },
  });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.transcript.length]);

  if (isLoading || !data) {
    return (
      <section style={sectionStyle}>
        <Header>Shot Plan</Header>
        <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 13 }}>Loading…</div>
      </section>
    );
  }

  const hasSavedPlan = (data.savedPlan?.length ?? 0) > 0;
  const hasLiveSession = data.transcript.length > 0 || data.proposedSteps.length > 0;
  const mode: Mode = refining || (hasLiveSession && !hasSavedPlan)
    ? 'chat'
    : hasSavedPlan
    ? 'accepted'
    : 'empty';

  const handleSend = () => {
    const t = input.trim();
    if (!t || sendMutation.isPending) return;
    setInput('');
    sendMutation.mutate(t);
  };

  const handleStartChat = () => {
    setRefining(true);
    // Empty mutation just to ensure session exists; user will type the first message.
    qc.invalidateQueries({ queryKey: ['shot-plan', projectId, sceneId] });
  };

  const handleCancel = () => {
    // If we have a previously-accepted plan, just drop the in-memory session — don't wipe disk.
    if (hasSavedPlan) {
      evictMutation.mutate();
    } else {
      // No saved plan: clearing the in-memory session is equivalent to DELETE (no-op on disk).
      discardMutation.mutate();
    }
  };

  return (
    <section style={sectionStyle}>
      <Header>Shot Plan</Header>

      {mode === 'empty' && (
        <div style={{ padding: 16 }}>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 12px' }}>
            Optional: get a step-by-step recording script the AI generates from this
            scene's intent. Refine via chat until it matches what you plan to record.
          </p>
          <button className="primary" onClick={handleStartChat}>
            Plan shots
          </button>
        </div>
      )}

      {mode === 'chat' && (
        <div style={{ display: 'flex', minHeight: 320 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              {data.transcript.length === 0 && (
                <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
                  Describe what you want to record — apps, commands, what you want shown.
                </div>
              )}
              {data.transcript.map((t, i) => (
                <ChatMessage
                  key={`${t.at}-${i}`}
                  role={t.role}
                  content={t.content}
                  timestamp={t.at}
                />
              ))}
              {sendMutation.isPending && (
                <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 8 }}>Thinking…</div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Tell the AI what to add, remove, or clarify…"
                rows={2}
                style={{ flex: 1, resize: 'none' }}
              />
              <button
                className="primary"
                onClick={handleSend}
                disabled={!input.trim() || sendMutation.isPending}
                style={{ alignSelf: 'flex-end' }}
              >
                Send
              </button>
            </div>
          </div>

          <aside
            style={{
              width: 320,
              borderLeft: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ padding: 12, borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
              Proposed steps ({data.proposedSteps.length})
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
              {data.proposedSteps.length === 0 ? (
                <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>None yet.</div>
              ) : (
                <ol style={{ paddingLeft: 18, margin: 0 }}>
                  {data.proposedSteps.map((s) => (
                    <li key={s.index} style={{ marginBottom: 8, fontSize: 13, lineHeight: 1.4 }}>
                      <div>{s.action}</div>
                      {s.note && (
                        <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 2 }}>
                          {s.note}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
              <button
                className="primary"
                onClick={() => acceptMutation.mutate()}
                disabled={data.proposedSteps.length === 0 || acceptMutation.isPending}
                style={{ flex: 1 }}
              >
                Accept plan
              </button>
              <button onClick={handleCancel}>Cancel</button>
            </div>
          </aside>
        </div>
      )}

      {mode === 'accepted' && (
        <div style={{ padding: 16 }}>
          <ol style={{ paddingLeft: 22, margin: '0 0 16px' }}>
            {data.savedPlan!.map((s: ShotPlanStep) => (
              <li key={s.index} style={{ marginBottom: 10, fontSize: 14, lineHeight: 1.5 }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={localTicked.has(s.index)}
                    onChange={(e) => {
                      const next = new Set(localTicked);
                      if (e.target.checked) next.add(s.index);
                      else next.delete(s.index);
                      setLocalTicked(next);
                    }}
                    style={{ marginTop: 4 }}
                  />
                  <span>
                    <span style={{ textDecoration: localTicked.has(s.index) ? 'line-through' : 'none' }}>
                      {s.action}
                    </span>
                    {s.note && (
                      <span style={{ color: 'var(--fg-muted)', fontSize: 12, display: 'block', marginTop: 2 }}>
                        {s.note}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ol>
          <div style={{ display: 'flex', gap: 8 }}>
            <a
              href={`/projects/${projectId}/scenes/${sceneId}/shot-plan/print`}
              target="_blank"
              rel="noreferrer"
              className="primary"
              style={{ padding: '8px 12px', textDecoration: 'none', display: 'inline-block' }}
            >
              Open print view
            </a>
            <button onClick={() => setRefining(true)}>Refine</button>
            <button
              onClick={() => {
                if (confirm('Discard this shot plan? This cannot be undone.')) {
                  discardMutation.mutate();
                }
              }}
              style={{ marginLeft: 'auto' }}
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const sectionStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg-elev)',
  marginBottom: 16,
};

function Header({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        fontSize: 14,
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Web typecheck**

Run: `npm run typecheck --workspace=@vpa/web`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ShotPlanSection.tsx
git commit -m "feat(web): ShotPlanSection — empty/chat/accepted states"
```

---

## Task 9: Wire `ShotPlanSection` into `ScenePage`

**Files:**
- Modify: `apps/web/src/pages/ScenePage.tsx`

The Recording tab renders `<RecordingUpload …/>`. We render `<ShotPlanSection …/>` directly above it.

- [ ] **Step 1: Locate the Recording tab render**

Run: `grep -n "RecordingUpload" apps/web/src/pages/ScenePage.tsx`
Note the line numbers — there is typically one `<RecordingUpload …/>` element inside an `activeTab === 'Recording' && (...)` block.

- [ ] **Step 2: Add the import**

Near the other component imports at the top of `apps/web/src/pages/ScenePage.tsx`, add:

```ts
import { ShotPlanSection } from '../components/ShotPlanSection.js';
```

- [ ] **Step 3: Render the section above `RecordingUpload`**

In the Recording-tab block (look for `activeTab === 'Recording'` or the JSX surrounding `<RecordingUpload`), insert `<ShotPlanSection projectId={projectId!} sceneId={sceneId!} />` immediately before `<RecordingUpload …/>`. Example:

```tsx
{activeTab === 'Recording' && (
  <>
    <ShotPlanSection projectId={projectId!} sceneId={sceneId!} />
    <RecordingUpload
      /* ...existing props unchanged... */
    />
    {/* existing siblings unchanged */}
  </>
)}
```

If the Recording tab is currently wrapped in `<div>` rather than a fragment, keep it as `<div>` and place `<ShotPlanSection …/>` as the first child.

- [ ] **Step 4: Web typecheck**

Run: `npm run typecheck --workspace=@vpa/web`
Expected: clean.

- [ ] **Step 5: Manual UI smoke**

Run dev: `npm run dev` (root).
Open a project, navigate to a scene, ensure the Recording tab now shows a "Shot Plan" section above the upload UI in its empty state. Click `Plan shots`, type "Plan it" in the chat, send, accept, see the checklist. Switch scenes — section state is per-scene.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/ScenePage.tsx
git commit -m "feat(web): render ShotPlanSection above RecordingUpload"
```

---

## Task 10: Print views + routes

**Files:**
- Create: `apps/web/src/pages/ShotPlanPrintView.tsx`
- Create: `apps/web/src/pages/ShotPlanProjectPrintView.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Per-scene print view**

Create `apps/web/src/pages/ShotPlanPrintView.tsx`:

```tsx
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { shotPlanApi, storyboardApi } from '../lib/api.js';

export function ShotPlanPrintView() {
  const { projectId, sceneId } = useParams<{ projectId: string; sceneId: string }>();
  const { data: plan } = useQuery({
    queryKey: ['shot-plan', projectId, sceneId],
    queryFn: () => shotPlanApi.get(projectId!, sceneId!),
    enabled: !!projectId && !!sceneId,
  });
  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  useEffect(() => {
    document.title = 'Shot Plan';
  }, []);

  const scene = storyboard?.scenes.find((s) => s.id === sceneId);
  const steps = plan?.savedPlan ?? [];

  return (
    <div style={{ padding: 32, maxWidth: 720, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <style>{printCss}</style>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>{scene?.name ?? 'Scene'}</h1>
      <div style={{ color: '#666', fontSize: 13, marginBottom: 24 }}>
        {scene?.description}
      </div>
      {steps.length === 0 ? (
        <div style={{ color: '#999' }}>No shot plan yet.</div>
      ) : (
        <ol style={{ paddingLeft: 24, lineHeight: 1.7 }}>
          {steps.map((s) => (
            <li key={s.index} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 15 }}>{s.action}</div>
              {s.note && <div style={{ color: '#666', fontSize: 13, marginTop: 2 }}>{s.note}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const printCss = `
  @media print {
    body { background: white; }
    @page { margin: 18mm; }
  }
`;
```

- [ ] **Step 2: Project-level runbook view**

Create `apps/web/src/pages/ShotPlanProjectPrintView.tsx`:

```tsx
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { storyboardApi } from '../lib/api.js';

export function ShotPlanProjectPrintView() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: storyboard } = useQuery({
    queryKey: ['storyboard', projectId],
    queryFn: () => storyboardApi.get(projectId!),
    enabled: !!projectId,
  });

  useEffect(() => {
    document.title = 'Shot Plans — Runbook';
  }, []);

  const scenes = (storyboard?.scenes ?? []).filter((s) => (s.shot_plan?.length ?? 0) > 0);

  return (
    <div style={{ padding: 32, maxWidth: 720, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <style>{`@media print { body { background: white; } @page { margin: 18mm; } .scene { page-break-inside: avoid; } }`}</style>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>{storyboard?.project.name ?? 'Project'} — Runbook</h1>
      <div style={{ color: '#666', fontSize: 13, marginBottom: 24 }}>
        {scenes.length} scene{scenes.length === 1 ? '' : 's'} planned.
      </div>
      {scenes.length === 0 && <div style={{ color: '#999' }}>No scenes have a shot plan yet.</div>}
      {scenes.map((scene, idx) => (
        <section className="scene" key={scene.id} style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>
            {idx + 1}. {scene.name}
          </h2>
          <div style={{ color: '#666', fontSize: 13, marginBottom: 10 }}>{scene.description}</div>
          <ol style={{ paddingLeft: 22, lineHeight: 1.7, margin: 0 }}>
            {scene.shot_plan!.map((s) => (
              <li key={s.index} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 14 }}>{s.action}</div>
                {s.note && <div style={{ color: '#666', fontSize: 12 }}>{s.note}</div>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Register the routes**

Edit `apps/web/src/App.tsx`. Add imports:

```ts
import { ShotPlanPrintView } from './pages/ShotPlanPrintView.js';
import { ShotPlanProjectPrintView } from './pages/ShotPlanProjectPrintView.js';
```

Add the two routes *outside* the `<Route path="/project/:projectId" element={<ProjectWorkspace />}>` block (i.e. as siblings — print views must not inherit the workspace chrome). Place them just before the catch-all `<Route path="*" …/>`:

```tsx
<Route
  path="/projects/:projectId/scenes/:sceneId/shot-plan/print"
  element={<ShotPlanPrintView />}
/>
<Route
  path="/projects/:projectId/shot-plans/print"
  element={<ShotPlanProjectPrintView />}
/>
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=@vpa/web`
Expected: clean.

- [ ] **Step 5: Manual print-view smoke**

Run dev: `npm run dev`. Accept a shot plan on any scene, then visit `/projects/<id>/scenes/<sceneId>/shot-plan/print` and `/projects/<id>/shot-plans/print` directly in the browser. Both should render without app chrome. Use the browser's Print preview to confirm `@media print` styles apply.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/ShotPlanPrintView.tsx apps/web/src/pages/ShotPlanProjectPrintView.tsx apps/web/src/App.tsx
git commit -m "feat(web): per-scene + project-wide shot-plan print views"
```

---

## Task 11: Passive checklist glyph on storyboard scene list

**Files:**
- Modify: `apps/web/src/components/StoryboardPreview.tsx`

- [ ] **Step 1: Read the file and find the per-scene render block**

Run: `grep -n "scene.type\|scene.name\|<div" apps/web/src/components/StoryboardPreview.tsx | head -20`
Identify the line range where each scene's row is rendered.

- [ ] **Step 2: Add a glyph adjacent to the scene name when `scene.shot_plan` is present**

Inside the scene-row JSX, after the existing scene-name display (or alongside the type badge), insert a small inline indicator. Example — adapt to fit the existing layout:

```tsx
{scene.shot_plan && scene.shot_plan.length > 0 && (
  <span
    title={`Shot plan ready (${scene.shot_plan.length} steps)`}
    style={{
      fontSize: 11,
      padding: '2px 6px',
      borderRadius: 4,
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      color: 'var(--fg-muted)',
      fontWeight: 500,
    }}
  >
    ✓ plan
  </span>
)}
```

Place the glyph inside the same flex row as the scene type badge so it sits next to existing chips. Do not add it to the empty case — when no scene has a plan, the layout is unchanged.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace=@vpa/web`
Expected: clean.

- [ ] **Step 4: Manual smoke**

Reload the Ideation page (which uses `StoryboardPreview`) and the storyboard view. Scenes with a saved shot plan should now show a small "✓ plan" chip; scenes without one should look identical to today.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/StoryboardPreview.tsx
git commit -m "feat(web): passive shot-plan glyph on scene preview rows"
```

---

## Task 12: Playwright e2e smoke

**Files:**
- Create: `tests/e2e/shot-plan.spec.ts`

- [ ] **Step 1: Confirm Playwright config + base URL**

Run: `cat tests/e2e/playwright.config.ts | head -40`
Note the `baseURL` and any `webServer` config. The e2e suite expects dev servers to be available — match the convention used by `tests/e2e/recordings.spec.ts` for project setup.

Run: `head -60 tests/e2e/recordings.spec.ts` to confirm the project-creation helper pattern used elsewhere; mirror it.

- [ ] **Step 2: Write the spec**

Create `tests/e2e/shot-plan.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// Mirrors tests/e2e/recordings.spec.ts conventions: create a project via UI,
// accept a storyboard via the ideation flow, then exercise the shot-plan
// section on the first scene.

test.describe('Shot Plan', () => {
  test('plan → message → accept → checklist → print', async ({ page, context }) => {
    // 1. Dashboard → new project
    await page.goto('/');
    await page.getByRole('button', { name: /new project/i }).click();
    await page.getByLabel(/project name/i).fill(`sp-${Date.now()}`);
    await page.getByLabel(/objective/i).fill('Demo shot plan');
    await page.getByRole('button', { name: /create/i }).click();

    // 2. Ideation → send → accept storyboard
    await page.getByRole('link', { name: /ideation/i }).click();
    await page.getByPlaceholder(/describe what you want to demo/i).fill('Demo the dev server boot');
    await page.getByRole('button', { name: /^send$/i }).click();
    await expect(page.getByRole('button', { name: /accept .*storyboard/i })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole('button', { name: /accept .*storyboard/i }).click();

    // 3. Open the first scene
    await page.getByRole('link', { name: /^scene/i }).first().click();
    await expect(page.getByRole('button', { name: /^plan shots$/i })).toBeVisible();

    // 4. Plan shots → first chat turn → accept
    await page.getByRole('button', { name: /^plan shots$/i }).click();
    await page.getByPlaceholder(/tell the AI what to add/i).fill('Plan it');
    await page.getByRole('button', { name: /^send$/i }).click();
    await expect(page.getByText(/proposed steps \(/i)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /^accept plan$/i }).click();

    // 5. Checklist visible + print link works
    await expect(page.getByRole('checkbox').first()).toBeVisible();
    const [printPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('link', { name: /open print view/i }).click(),
    ]);
    await printPage.waitForLoadState();
    await expect(printPage.locator('ol li').first()).toBeVisible();
  });
});
```

- [ ] **Step 3: Run the spec**

Run: `npm run test:e2e -- shot-plan`
Expected: PASS — full flow completes against dev servers. (If the dev-server bootstrapping convention differs, mirror what `recordings.spec.ts` does — e.g. `test.beforeAll` to start services. Do not skip; fix the spec to match.)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/shot-plan.spec.ts
git commit -m "test(e2e): shot-plan smoke covering plan → accept → print"
```

---

## Final verification

- [ ] **Whole-suite typecheck**

Run: `npm run typecheck`
Expected: clean across all workspaces.

- [ ] **Whole-suite unit tests**

Run: `npm run test`
Expected: PASS — including the new `shared`, `server/services/shot-plan`, `server/routes/shot-plan`, and `web/lib/parse-json-block` cases.

- [ ] **E2E**

Run: `npm run test:e2e -- shot-plan`
Expected: PASS.

- [ ] **Manual smoke against a real LLM**

If a real Gemini or Claude key is configured: run dev, plan shots on one scene, refine once with a specific instruction ("the URL is `http://localhost:3000`"), and confirm the model honors it. Document any surprising behavior in a follow-up issue — do not block this plan on it.

- [ ] **Update `docs/superpowers/plans/2026-05-19-10-scene-shot-plan.md`**

Check off every step in this plan as completed.

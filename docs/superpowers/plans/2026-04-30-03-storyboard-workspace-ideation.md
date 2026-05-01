# Plan 03 — Storyboard, Project Workspace & Ideation Chat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the storyboard data model, a project workspace UI with sidebar navigation, and an AI-powered ideation chat where users describe what they want to demo and the AI proposes a storyboard with scenes. This is the core user flow — every later feature (recording, narration, lower thirds) builds on top of storyboard + workspace.

**Architecture:** Builds on Plans 01 & 02. Adds storyboard + state zod schemas to `@vpa/shared`, a storyboard service for CRUD on `storyboard.yaml`, an ideation service that uses the LLM interface to generate scene proposals from user messages, SSE-streamed chat responses, and a React project workspace with sidebar nav, overview page, storyboard view, and two-column ideation chat page.

**Tech Stack additions** (on top of Plans 01-02):
- No new dependencies required. Uses existing: Fastify, TanStack Query, react-router nested routes, LLM client interface, job queue, SSE infrastructure.

**Spec reference:** `docs/superpowers/specs/2026-04-29-vpa-phase1-design.md`, sections 2.1 (ideation workflow), 4 (storyboard.yaml), 5.1-5.3 (workspace + ideation UI).

---

## File Structure (created or modified in this plan)

```
packages/shared/src/
├── storyboard.ts                                        NEW — Storyboard, Scene, Recording, Narration, LowerThird schemas
├── state.ts                                             NEW — ProjectState schema
└── index.ts                                             MODIFY — re-export new schemas

apps/server/src/
├── server.ts                                            MODIFY — register storyboard + ideation routes
├── services/
│   ├── storyboard/
│   │   ├── index.ts                                     NEW — load / save / validate / mutate storyboard.yaml
│   │   └── index.test.ts                                NEW
│   └── ideation/
│       ├── index.ts                                     NEW — orchestrator: chat history + LLM scene generation
│       └── index.test.ts                                NEW
├── routes/
│   ├── storyboard.ts                                    NEW — GET / PUT storyboard, scene CRUD
│   ├── storyboard.test.ts                               NEW
│   ├── ideation.ts                                      NEW — POST message, GET session, POST accept, SSE stream
│   └── ideation.test.ts                                 NEW

apps/server/src/services/llm/
└── fake.ts                                              MODIFY — add ideation response support

prompts/
└── ideation-system.md                                   NEW — system prompt for ideation chat

apps/web/src/
├── App.tsx                                              MODIFY — add project workspace routes
├── lib/
│   └── api.ts                                           MODIFY — add storyboard + ideation API methods
├── pages/
│   ├── Dashboard.tsx                                    MODIFY — navigate to /project/:id on project click
│   ├── ProjectWorkspace.tsx                             NEW — sidebar layout + Outlet
│   ├── ProjectOverview.tsx                              NEW — project summary
│   ├── StoryboardView.tsx                               NEW — scene list, edit, reorder
│   └── Ideation.tsx                                     NEW — two-column chat + live storyboard preview
├── components/
│   ├── ProjectSidebar.tsx                               NEW — workspace sidebar navigation
│   ├── ChatMessage.tsx                                  NEW — chat bubble component
│   └── StoryboardPreview.tsx                            NEW — live scene list preview

tests/e2e/
└── ideation.spec.ts                                     NEW
```

---

## Task 1: Storyboard + State zod schemas

**Files:**
- Create: `packages/shared/src/storyboard.ts`
- Create: `packages/shared/src/state.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create `packages/shared/src/storyboard.ts`**

```ts
import { z } from 'zod';

export const RecordingSchema = z.object({
  source: z.string(),
  duration_sec: z.number().positive().optional(),
  ingested_at: z.string().datetime().optional(),
});
export type Recording = z.infer<typeof RecordingSchema>;

export const TimingSchema = z.object({
  word: z.string(),
  t: z.number(),
});
export type Timing = z.infer<typeof TimingSchema>;

export const NarrationSchema = z.object({
  script: z.string(),
  audio: z.string().optional(),
  subtitles: z.object({
    srt: z.string().optional(),
    vtt: z.string().optional(),
  }).optional(),
  tts: z.object({
    engine: z.string().optional(),
    voice: z.string().optional(),
    speed: z.number().positive().optional(),
  }).optional(),
  timings: z.array(TimingSchema).optional(),
});
export type Narration = z.infer<typeof NarrationSchema>;

export const LowerThirdSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  style: z.enum(['frosted', 'solid', 'minimal']).default('frosted'),
  in_sec: z.number().min(0),
  out_sec: z.number().min(0),
});
export type LowerThird = z.infer<typeof LowerThirdSchema>;

export const ReviewSchema = z.object({
  status: z.enum(['ok', 'warnings', 'issues']),
  notes: z.array(z.string()),
});
export type Review = z.infer<typeof ReviewSchema>;

export const SceneTypeSchema = z.enum(['desktop', 'terminal', 'browser', 'slide']);
export type SceneType = z.infer<typeof SceneTypeSchema>;

export const SceneSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string(),
  type: SceneTypeSchema.default('desktop'),
  recording: RecordingSchema.optional(),
  narration: NarrationSchema.optional(),
  lower_thirds: z.array(LowerThirdSchema).optional(),
  overlay_render: z.string().optional(),
  review: ReviewSchema.optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const StoryboardDefaultsSchema = z.object({
  brand: z.string().optional(),
  voice_profile: z.string().optional(),
  tts_engine: z.string().optional(),
});
export type StoryboardDefaults = z.infer<typeof StoryboardDefaultsSchema>;

export const StoryboardProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  created: z.string().datetime(),
  objective: z.string().optional(),
  audience: z.string().optional(),
  source_docs: z.array(z.string()).optional(),
});

export const StoryboardSchema = z.object({
  schema_version: z.literal(1),
  project: StoryboardProjectSchema,
  defaults: StoryboardDefaultsSchema.optional(),
  scenes: z.array(SceneSchema),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;
```

- [ ] **Step 2: Create `packages/shared/src/state.ts`**

```ts
import { z } from 'zod';

export const StageStatusSchema = z.enum(['pending', 'running', 'complete', 'failed']);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const ProjectStateSchema = z.object({
  ideation: StageStatusSchema.optional(),
  ingestion: StageStatusSchema.optional(),
  scripts: z.record(z.string(), StageStatusSchema).optional(),
  narration: z.record(z.string(), StageStatusSchema).optional(),
  lower_thirds: z.record(z.string(), StageStatusSchema).optional(),
  subtitles: z.record(z.string(), StageStatusSchema).optional(),
  review: StageStatusSchema.optional(),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;
```

- [ ] **Step 3: Modify `packages/shared/src/index.ts`**

Add re-exports:
```ts
export * from './storyboard.js';
export * from './state.js';
```

- [ ] **Step 4: Build shared package**

Run: `npm run build -w @vpa/shared`

- [ ] **Step 5: Commit**

---

## Task 2: Storyboard service

**Files:**
- Create: `apps/server/src/services/storyboard/index.ts`
- Create: `apps/server/src/services/storyboard/index.test.ts`

The storyboard service handles loading, saving, validating, and mutating `storyboard.yaml`. It is a pure module — no knowledge of HTTP.

- [ ] **Step 1: Write failing tests**

Tests for: `loadStoryboard` (returns null for missing file, parses valid YAML), `saveStoryboard` (writes YAML), `createStoryboard` (builds initial storyboard from project metadata), `addScene`, `updateScene`, `removeScene`, `reorderScenes`.

- [ ] **Step 2: Implement the service**

Key methods:
- `loadStoryboard(projectRoot: string): Promise<Storyboard | null>`
- `saveStoryboard(projectRoot: string, storyboard: Storyboard): Promise<void>`
- `createStoryboard(project: Project, scenes: Scene[]): Storyboard`
- `addScene(sb: Storyboard, scene: Scene): Storyboard`
- `updateScene(sb: Storyboard, sceneId: string, patch: Partial<Scene>): Storyboard`
- `removeScene(sb: Storyboard, sceneId: string): Storyboard`
- `reorderScenes(sb: Storyboard, orderedIds: string[]): Storyboard`

Uses `loadYaml` / `dumpYaml` from `lib/yaml.ts` and `atomicWriteFile` from `lib/fs-atomic.ts`.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

---

## Task 3: Ideation service

**Files:**
- Create: `apps/server/src/services/ideation/index.ts`
- Create: `apps/server/src/services/ideation/index.test.ts`
- Modify: `apps/server/src/services/llm/fake.ts`
- Create: `prompts/ideation-system.md`

The ideation service maintains per-project chat sessions in memory and uses the LLM client to generate scene proposals from user messages.

- [ ] **Step 1: Create `prompts/ideation-system.md`**

System prompt for the ideation LLM. Instructs the AI to act as a demo video planner, propose scenes with ids/names/descriptions/types, and respond with JSON scene arrays when proposing or updating scenes.

- [ ] **Step 2: Update fake LLM to handle ideation**

When the system prompt contains "ideation" or "storyboard", the fake LLM returns a mock response with scene proposals in a structured format.

- [ ] **Step 3: Write failing tests for IdeationSession**

Tests for: creating a session, sending a message and getting back a response with scenes, modifying scenes via refinement messages, getting session history.

- [ ] **Step 4: Implement IdeationSession**

```ts
interface IdeationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  scenes?: Scene[];
  timestamp: string;
}

class IdeationSession {
  messages: IdeationMessage[];
  proposedScenes: Scene[];

  async sendMessage(content: string, llm: LlmClient): Promise<IdeationMessage>;
  getState(): { messages: IdeationMessage[]; scenes: Scene[] };
}
```

The `sendMessage` method:
1. Appends user message to history
2. Builds LLM prompt from system prompt + chat history + current scenes
3. Calls LLM, parses response for text + scene proposals
4. Appends assistant message
5. Updates proposedScenes

- [ ] **Step 5: Implement IdeationManager**

Maps projectId → IdeationSession. Manages lifecycle.

- [ ] **Step 6: Run tests, verify pass**
- [ ] **Step 7: Commit**

---

## Task 4: Storyboard routes

**Files:**
- Create: `apps/server/src/routes/storyboard.ts`
- Create: `apps/server/src/routes/storyboard.test.ts`
- Modify: `apps/server/src/server.ts`

- [ ] **Step 1: Create storyboard route handlers**

Routes:
- `GET /api/projects/:id/storyboard` — load storyboard for project
- `PUT /api/projects/:id/storyboard` — save full storyboard
- `POST /api/projects/:id/storyboard/scenes` — add a scene
- `PUT /api/projects/:id/storyboard/scenes/:sceneId` — update a scene
- `DELETE /api/projects/:id/storyboard/scenes/:sceneId` — remove a scene
- `PUT /api/projects/:id/storyboard/scenes/reorder` — reorder scenes

All routes resolve the project path from the tracker, then delegate to the storyboard service.

- [ ] **Step 2: Write integration tests**
- [ ] **Step 3: Wire into server.ts**
- [ ] **Step 4: Run tests, verify pass**
- [ ] **Step 5: Commit**

---

## Task 5: Ideation routes

**Files:**
- Create: `apps/server/src/routes/ideation.ts`
- Create: `apps/server/src/routes/ideation.test.ts`
- Modify: `apps/server/src/server.ts`

- [ ] **Step 1: Create ideation route handlers**

Routes:
- `GET /api/projects/:id/ideation` — get current session state (messages + proposed scenes)
- `POST /api/projects/:id/ideation/message` — send a user message, returns the assistant response
- `POST /api/projects/:id/ideation/accept` — accept proposed scenes, write storyboard.yaml

The accept endpoint:
1. Gets proposed scenes from the ideation session
2. Creates a storyboard via the storyboard service
3. Saves it to disk
4. Updates project state
5. Returns the storyboard

- [ ] **Step 2: Write integration tests**
- [ ] **Step 3: Wire into server.ts**
- [ ] **Step 4: Run tests, verify pass**
- [ ] **Step 5: Commit**

---

## Task 6: Web API client extensions

**Files:**
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Add storyboard API methods**

```ts
export const storyboardApi = {
  get(projectId: string): Promise<Storyboard | null>,
  save(projectId: string, storyboard: Storyboard): Promise<Storyboard>,
  addScene(projectId: string, scene: Scene): Promise<Storyboard>,
  updateScene(projectId: string, sceneId: string, patch: Partial<Scene>): Promise<Storyboard>,
  removeScene(projectId: string, sceneId: string): Promise<Storyboard>,
  reorderScenes(projectId: string, orderedIds: string[]): Promise<Storyboard>,
};
```

- [ ] **Step 2: Add ideation API methods**

```ts
export const ideationApi = {
  getSession(projectId: string): Promise<IdeationState>,
  sendMessage(projectId: string, content: string): Promise<IdeationMessage>,
  accept(projectId: string): Promise<Storyboard>,
};
```

- [ ] **Step 3: Commit**

---

## Task 7: Project workspace layout + sidebar

**Files:**
- Create: `apps/web/src/pages/ProjectWorkspace.tsx`
- Create: `apps/web/src/components/ProjectSidebar.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Create ProjectSidebar component**

Sidebar nav matching spec §5.1:
- Project name at top
- Overview link
- Storyboard link
- Ideation link (new, for the chat)
- Scenes section (dynamically lists scenes from storyboard)
- Divider
- Library section (Brands link)
- Back to all projects link at bottom

Uses react-router `NavLink` for active state.

- [ ] **Step 2: Create ProjectWorkspace layout**

Fetches the project by ID (from tracker), renders sidebar + `<Outlet />` for nested routes.

- [ ] **Step 3: Update App.tsx with nested routes**

```tsx
<Route path="/project/:projectId" element={<ProjectWorkspace />}>
  <Route index element={<ProjectOverview />} />
  <Route path="storyboard" element={<StoryboardView />} />
  <Route path="ideation" element={<Ideation />} />
</Route>
```

- [ ] **Step 4: Commit**

---

## Task 8: Project overview page

**Files:**
- Create: `apps/web/src/pages/ProjectOverview.tsx`

Shows project metadata (name, objective, audience, created date), storyboard summary (scene count, completion status), and action buttons (go to ideation, go to storyboard).

- [ ] **Step 1: Implement ProjectOverview**
- [ ] **Step 2: Commit**

---

## Task 9: Storyboard view page

**Files:**
- Create: `apps/web/src/pages/StoryboardView.tsx`

Shows the full scene list. Each scene is a card showing id, name, description, type, and status indicators for recording/narration/lower-thirds. Scenes can be reordered (up/down buttons for now — drag deferred). Edit scene name/description inline. Add/remove scenes.

- [ ] **Step 1: Implement StoryboardView**
- [ ] **Step 2: Commit**

---

## Task 10: Ideation chat page

**Files:**
- Create: `apps/web/src/pages/Ideation.tsx`
- Create: `apps/web/src/components/ChatMessage.tsx`
- Create: `apps/web/src/components/StoryboardPreview.tsx`

Two-column layout per spec §5.3:
- **Left:** Chat history + reply box. User types messages, AI responds with text and scene proposals.
- **Right:** Live storyboard preview showing proposed scenes. Each scene card has an inline edit button that sends a refinement message.
- **Bottom-right:** "Accept & create storyboard" button. Disabled until scenes >= 1.

- [ ] **Step 1: Create ChatMessage component**

Renders a single chat message bubble. User messages right-aligned, assistant left-aligned. Assistant messages may include embedded scene proposals rendered as chips.

- [ ] **Step 2: Create StoryboardPreview component**

Renders the proposed scene list. Each scene shows name, description, type badge. Edit button sends a refinement message to the chat.

- [ ] **Step 3: Implement Ideation page**

Two-column layout. Left column is scrollable chat + input. Right column is sticky storyboard preview + accept button.

- [ ] **Step 4: Commit**

---

## Task 11: Dashboard navigation to projects

**Files:**
- Modify: `apps/web/src/pages/Dashboard.tsx`
- Modify: `apps/web/src/components/ProjectList.tsx`

- [ ] **Step 1: Update ProjectList to use react-router navigation**

When a project is clicked, navigate to `/project/:id` instead of just logging.

- [ ] **Step 2: Update Dashboard front-door buttons**

"Ideate a new demo" should create a project then navigate to `/project/:id/ideation`.
"I have recordings" should create a project then navigate to `/project/:id` (recording upload is a later plan).

- [ ] **Step 3: Commit**

---

## Task 12: E2E smoke test

**Files:**
- Create: `tests/e2e/ideation.spec.ts`

- [ ] **Step 1: Write E2E test**

Test flow:
1. Navigate to dashboard
2. Click "Ideate a new demo"
3. Fill in project name, click Create
4. Lands on ideation page
5. Type a message in the chat
6. See AI response with scene proposals
7. Click "Accept & create storyboard"
8. Redirected to storyboard view with scenes

- [ ] **Step 2: Run E2E**
- [ ] **Step 3: Commit**

---

## Task 13: Final verification

- [ ] **Step 1: Run full gauntlet**

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run e2e
```

- [ ] **Step 2: Commit any fixes**

---

## Verification Summary

After all 13 tasks, a user running `npm run dev` should be able to:
1. Open the dashboard, click "Ideate a new demo"
2. Create a project, land on the ideation chat page
3. Type "I want to demo setting up an MCP server with Claude Desktop"
4. See AI respond with proposed scenes (fake LLM in dev)
5. Click "Accept & create storyboard"
6. See the storyboard view with all proposed scenes
7. Navigate between Overview, Storyboard, and Ideation via the sidebar
8. Edit scene names/descriptions inline on the storyboard page
9. Click "All projects" to return to the dashboard

## What this plan does NOT deliver (deferred)

- Recording upload/ingestion (Plan 04)
- Script generation from video (Plan 04)
- TTS / Narration (Plan 05)
- Lower thirds (Plan 05)
- Quality review (Plan 06)
- Scene detail page with tabs (Plan 04)
- Real LLM providers (separate plan)
- Streaming SSE for ideation responses (uses request/response for now; streaming deferred)

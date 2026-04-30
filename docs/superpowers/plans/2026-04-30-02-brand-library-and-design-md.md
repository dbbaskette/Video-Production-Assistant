# Plan 02 — Brand Library & design.md Generation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Brand Library to the VPA dashboard. Users upload brand documents (PDF, MD, URL, free text, existing design.md), the system extracts brand information using an LLM, and produces a Google design.md file extended with a `vpa:` namespace. Brands are CRUD-able, forkable, downloadable as portable files, and applicable to projects.

**Architecture:** Builds on Plan 01's foundation. Adds three new server services (`document-extract`, `brand`, `brand-generation`), an LLM service interface with a fake provider for dev/testing, a minimal in-memory job queue + SSE infrastructure, Fastify multipart uploads, and React UI for the brand library. The plan delivers a fully working brand-creation flow end-to-end with a fake LLM; real provider implementations are a follow-on plan.

**Tech Stack additions** (on top of Plan 01):
- Server: `@fastify/multipart` 8, `gray-matter` 4 (front-matter parser), `pdf-parse` 1 (fallback PDF extractor), `cheerio` 1 + `@mozilla/readability` 0.5 (fallback URL extractor), `wcag-contrast` 3 (contrast ratio computation)
- Web: `react-markdown` 9 (markdown renderer for live preview), `@codemirror/lang-yaml` + `@codemirror/lang-markdown` + `@uiw/react-codemirror` 4 (power-user markdown editor)
- External: MarkItDown (Python 3.10+) — soft prerequisite for high-quality extraction; falls back to pdf-parse + cheerio when missing

**Spec reference:** `docs/superpowers/specs/2026-04-30-brand-library-and-design-md.md`

---

## File Structure (created or modified in this plan)

```
prompts/                                                 NEW — editable system prompts
├── brand-extract-tokens.md
└── brand-write-rationale.md

packages/shared/src/
├── design-md.ts                                         NEW — DesignMd, DesignMdFrontMatter, VpaExtensions
├── brand.ts                                             NEW — BrandRegistry, BrandRegistryEntry, BrandWithDoc
├── job.ts                                               NEW — Job, JobEvent
└── project.ts                                           MODIFY — add brand field

apps/server/
├── package.json                                         MODIFY — new deps
└── src/
    ├── server.ts                                        MODIFY — register multipart, job + brand routes
    ├── lib/
    │   └── job-queue.ts                                 NEW — in-memory queue + SSE event emitter
    ├── routes/
    │   ├── jobs.ts                                      NEW — SSE endpoint
    │   └── brands.ts                                    NEW — full brand REST API
    └── services/
        ├── llm/
        │   ├── index.ts                                 NEW — LlmClient interface
        │   ├── fake.ts                                  NEW — fake provider for dev/test
        │   └── prompts.ts                               NEW — load editable prompts from disk
        ├── document-extract/
        │   ├── index.ts                                 NEW — orchestrator
        │   ├── detect.ts                                NEW — MarkItDown availability check
        │   ├── markitdown.ts                            NEW — subprocess wrapper
        │   ├── fallback-pdf.ts                          NEW — pdf-parse
        │   └── fallback-url.ts                          NEW — cheerio + readability
        ├── brand/
        │   ├── index.ts                                 NEW — public API
        │   ├── paths.ts                                 NEW — path helpers
        │   ├── registry.ts                              NEW — brands.json read/write
        │   ├── store.ts                                 NEW — brand directory operations
        │   ├── fork.ts                                  NEW — fork-on-edit
        │   ├── validate.ts                              NEW — schema + contrast checks
        │   └── download.ts                              NEW — assemble file for download
        └── brand-generation/
            ├── index.ts                                 NEW — pipeline orchestrator
            ├── extract-tokens.ts                        NEW — LLM call #1
            ├── write-rationale.ts                       NEW — LLM call #2
            └── assemble.ts                              NEW — combine front matter + body

apps/web/
├── package.json                                         MODIFY — new deps
└── src/
    ├── App.tsx                                          MODIFY — add brand routes
    ├── lib/
    │   └── api.ts                                       MODIFY — extend with brand methods
    ├── pages/
    │   ├── Dashboard.tsx                                MODIFY — add Brands section
    │   ├── BrandNew.tsx                                 NEW — wizard
    │   └── BrandDetail.tsx                              NEW — detail page
    └── components/
        ├── BrandCard.tsx                                NEW
        ├── BrandPicker.tsx                              NEW
        ├── BrandReviewForm.tsx                          NEW
        ├── BrandPreviewPane.tsx                         NEW
        └── BrandUpdateBanner.tsx                        NEW

tests/e2e/
└── brand-creation.spec.ts                               NEW

README.md                                                MODIFY — MarkItDown prereq + brand feature notes
.env.example                                             MODIFY — LLM provider env vars
```

---

## Task 1: Job queue + SSE infrastructure

**Files:**
- Create: `packages/shared/src/job.ts`
- Create: `apps/server/src/lib/job-queue.ts`
- Create: `apps/server/src/lib/job-queue.test.ts`
- Create: `apps/server/src/routes/jobs.ts`
- Modify: `apps/server/src/server.ts` (register jobs route)
- Modify: `packages/shared/src/index.ts` (re-export Job types)

- [ ] **Step 1: Add Job and JobEvent types to shared package**

Create `packages/shared/src/job.ts`:

```typescript
import { z } from 'zod';

export const JobStatus = z.enum([
  'pending',
  'running',
  'awaiting-input',
  'completed',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobEvent = z.object({
  type: z.string(),                    // e.g. "extracting:source-1", "tokens-ready"
  timestamp: z.string(),               // ISO 8601
  data: z.unknown().optional(),        // arbitrary payload
});
export type JobEvent = z.infer<typeof JobEvent>;

export const Job = z.object({
  id: z.string().uuid(),
  type: z.string(),                    // e.g. "brand.extract"
  status: JobStatus,
  created: z.string(),
  updated: z.string(),
  events: z.array(JobEvent),
  result: z.unknown().optional(),      // populated on completion
  error: z.string().optional(),        // populated on failure
});
export type Job = z.infer<typeof Job>;
```

- [ ] **Step 2: Re-export from shared package**

Modify `packages/shared/src/index.ts` (add to existing re-exports):

```typescript
export * from './job.js';
```

- [ ] **Step 3: Write failing test for job-queue create + emit**

Create `apps/server/src/lib/job-queue.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { JobQueue } from './job-queue.js';

describe('JobQueue', () => {
  let queue: JobQueue;
  beforeEach(() => { queue = new JobQueue(); });

  it('creates a job with pending status', () => {
    const job = queue.create('brand.extract');
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.status).toBe('pending');
    expect(job.type).toBe('brand.extract');
    expect(job.events).toEqual([]);
  });

  it('emits events to subscribers and stores them on the job', () => {
    const job = queue.create('brand.extract');
    const received: any[] = [];
    queue.subscribe(job.id, (evt) => received.push(evt));
    queue.emit(job.id, 'persisted', { count: 2 });
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('persisted');
    expect(received[0].data).toEqual({ count: 2 });
    expect(queue.get(job.id)!.events).toHaveLength(1);
  });

  it('transitions through statuses', () => {
    const job = queue.create('brand.extract');
    queue.setStatus(job.id, 'running');
    expect(queue.get(job.id)!.status).toBe('running');
    queue.complete(job.id, { brand_slug: 'tanzu' });
    expect(queue.get(job.id)!.status).toBe('completed');
    expect(queue.get(job.id)!.result).toEqual({ brand_slug: 'tanzu' });
  });

  it('records error on fail', () => {
    const job = queue.create('brand.extract');
    queue.fail(job.id, 'LLM rejected JSON');
    expect(queue.get(job.id)!.status).toBe('failed');
    expect(queue.get(job.id)!.error).toBe('LLM rejected JSON');
  });

  it('replays past events to a late subscriber', () => {
    const job = queue.create('brand.extract');
    queue.emit(job.id, 'a');
    queue.emit(job.id, 'b');
    const received: any[] = [];
    queue.subscribe(job.id, (evt) => received.push(evt), { replay: true });
    expect(received.map(e => e.type)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 4: Run the test (must fail)**

Run: `npm --workspace apps/server test -- job-queue`
Expected: FAIL with "Cannot find module './job-queue.js'"

- [ ] **Step 5: Implement JobQueue**

Create `apps/server/src/lib/job-queue.ts`:

```typescript
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Job, JobEvent, JobStatus } from '@vpa/shared';

type Listener = (event: JobEvent) => void;

interface SubscribeOptions {
  replay?: boolean;
}

export class JobQueue {
  private jobs = new Map<string, Job>();
  private emitters = new Map<string, EventEmitter>();

  create(type: string): Job {
    const id = randomUUID();
    const now = new Date().toISOString();
    const job: Job = {
      id,
      type,
      status: 'pending',
      created: now,
      updated: now,
      events: [],
    };
    this.jobs.set(id, job);
    this.emitters.set(id, new EventEmitter());
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  setStatus(id: string, status: JobStatus): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = status;
    job.updated = new Date().toISOString();
  }

  emit(id: string, type: string, data?: unknown): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    const event: JobEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    job.events.push(event);
    job.updated = event.timestamp;
    this.emitters.get(id)!.emit('event', event);
  }

  subscribe(id: string, listener: Listener, opts: SubscribeOptions = {}): () => void {
    const emitter = this.emitters.get(id);
    if (!emitter) throw new Error(`Job not found: ${id}`);
    if (opts.replay) {
      const job = this.jobs.get(id)!;
      for (const event of job.events) listener(event);
    }
    emitter.on('event', listener);
    return () => emitter.off('event', listener);
  }

  complete(id: string, result?: unknown): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = 'completed';
    job.result = result;
    job.updated = new Date().toISOString();
    this.emit(id, 'done', result);
  }

  fail(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = 'failed';
    job.error = error;
    job.updated = new Date().toISOString();
    this.emit(id, 'error', { error });
  }
}

// Singleton instance — server registers and shares this.
export const jobQueue = new JobQueue();
```

- [ ] **Step 6: Run tests (must pass)**

Run: `npm --workspace apps/server test -- job-queue`
Expected: PASS, 5 tests passing.

- [ ] **Step 7: Implement SSE route**

Create `apps/server/src/routes/jobs.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { jobQueue } from '../lib/job-queue.js';

export async function registerJobRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = jobQueue.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    return job;
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id/stream', async (req, reply) => {
    const job = jobQueue.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    const write = (event: { type: string; timestamp: string; data?: unknown }) => {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = jobQueue.subscribe(req.params.id, write, { replay: true });

    // Close connection when terminal status reached.
    const checkTerminal = () => {
      const j = jobQueue.get(req.params.id)!;
      if (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') {
        unsubscribe();
        reply.raw.end();
      }
    };
    const interval = setInterval(checkTerminal, 500);

    req.raw.on('close', () => {
      clearInterval(interval);
      unsubscribe();
    });
  });
}
```

- [ ] **Step 8: Register the route in server bootstrap**

Modify `apps/server/src/server.ts` — add inside the `buildServer` function after existing route registrations:

```typescript
import { registerJobRoutes } from './routes/jobs.js';
// ... inside buildServer:
await registerJobRoutes(app);
```

- [ ] **Step 9: Smoke-test the SSE endpoint manually**

Run: `npm --workspace apps/server dev` then in another terminal:

```bash
# Create a test job (we'll use a temporary endpoint or node script)
node -e "
  import('./apps/server/src/lib/job-queue.js').then(({ jobQueue }) => {
    const j = jobQueue.create('test');
    console.log('Job ID:', j.id);
    setTimeout(() => jobQueue.emit(j.id, 'tick'), 500);
    setTimeout(() => jobQueue.complete(j.id, { ok: true }), 1500);
  });
"
# In another terminal:
curl -N http://localhost:4000/api/jobs/<JOB_ID>/stream
```

Expected: SSE stream emitting `event: tick`, then `event: done`, then connection closes.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/job.ts packages/shared/src/index.ts \
        apps/server/src/lib/job-queue.ts apps/server/src/lib/job-queue.test.ts \
        apps/server/src/routes/jobs.ts apps/server/src/server.ts
git commit -m "feat(jobs): in-memory job queue with SSE event streaming"
```

---

## Task 2: Shared schemas — design.md and Brand types

**Files:**
- Create: `packages/shared/src/design-md.ts`
- Create: `packages/shared/src/brand.ts`
- Create: `packages/shared/src/design-md.test.ts`
- Modify: `packages/shared/src/project.ts` (add brand field)
- Modify: `packages/shared/src/index.ts` (re-exports)

- [ ] **Step 1: Write failing test for DesignMdFrontMatter schema**

Create `packages/shared/src/design-md.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DesignMdFrontMatter, VpaExtensions } from './design-md.js';

describe('DesignMdFrontMatter', () => {
  it('accepts a valid front matter object', () => {
    const valid = {
      name: 'Tanzu',
      version: 1,
      colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
      typography: {
        heading: { family: 'Inter', weights: [600, 700] },
        body:    { family: 'Inter', weights: [400] },
      },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4, 8, 16, 24] },
      components: {},
    };
    const parsed = DesignMdFrontMatter.parse(valid);
    expect(parsed.name).toBe('Tanzu');
  });

  it('rejects invalid hex color', () => {
    const bad = {
      name: 'Tanzu',
      version: 1,
      colors: { primary: 'not-a-color', surface: '#FFF', on_surface: '#000' },
      typography: { heading: { family: 'Inter', weights: [400] }, body: { family: 'Inter', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4, 8] },
      components: {},
    };
    expect(() => DesignMdFrontMatter.parse(bad)).toThrow();
  });

  it('accepts vpa extensions when present', () => {
    const withVpa = {
      name: 'Tanzu',
      version: 1,
      colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
      typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4, 8] },
      components: {},
      vpa: {
        voice: { tone: 'Confident', avoid: ['jargon'] },
        audio: { music_mood: 'uplifting', sonic_logo: null },
        logo:  { primary: 'assets/logo.svg', mono: 'assets/logo-mono.png', safe_zone_ratio: 0.25 },
        lower_thirds: { template: 'bar-left-accent', bg: '{colors.primary}', fg: '{colors.on_surface}' },
        taglines: ['Build cloud-native, faster'],
      },
    };
    const parsed = DesignMdFrontMatter.parse(withVpa);
    expect(parsed.vpa?.voice.tone).toBe('Confident');
  });

  it('rejects unknown top-level fields', () => {
    const bad = {
      name: 'Tanzu',
      version: 1,
      colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
      typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4, 8] },
      components: {},
      not_a_real_field: 'oops',
    };
    expect(() => DesignMdFrontMatter.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test (must fail)**

Run: `npm --workspace packages/shared test -- design-md`
Expected: FAIL with "Cannot find module './design-md.js'"

- [ ] **Step 3: Implement design-md.ts**

Create `packages/shared/src/design-md.ts`:

```typescript
import { z } from 'zod';

const HexColor = z.string().regex(/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/, 'Must be #RRGGBB or #RRGGBBAA');
const FontWeight = z.number().int().min(100).max(900).refine((n) => n % 100 === 0, 'Weight must be a 100-step value');

const Typography = z.object({
  heading: z.object({ family: z.string().min(1), weights: z.array(FontWeight).min(1) }),
  body:    z.object({ family: z.string().min(1), weights: z.array(FontWeight).min(1) }),
}).strict();

const Spacing = z.object({
  unit: z.number().int().positive(),
  scale: z.array(z.number().int().positive()).min(1).refine(
    (arr) => arr.every((v, i) => i === 0 || v >= arr[i - 1]),
    'Spacing scale must be non-decreasing',
  ),
}).strict();

const Rounded = z.object({
  sm: z.number().int().nonnegative(),
  md: z.number().int().nonnegative(),
  lg: z.number().int().nonnegative(),
}).strict();

const Colors = z.object({
  primary:    HexColor,
  surface:    HexColor,
  on_surface: HexColor,
  accent:     HexColor.optional(),
}).catchall(HexColor); // allow extra named colors but they must be hex

export const VpaExtensions = z.object({
  voice: z.object({
    tone: z.string(),
    avoid: z.array(z.string()).default([]),
  }).strict(),
  audio: z.object({
    music_mood: z.string().nullable(),
    sonic_logo: z.string().nullable(),
  }).strict(),
  logo: z.object({
    primary: z.string().nullable(),
    mono:    z.string().nullable(),
    safe_zone_ratio: z.number().min(0).max(1).default(0.25),
  }).strict(),
  lower_thirds: z.object({
    template: z.enum(['bar-left-accent', 'centered-fade', 'minimal-line']),
    bg: z.string(),                  // hex or {colors.x} reference
    fg: z.string(),
  }).strict(),
  taglines: z.array(z.string()).default([]),
}).strict();

export type VpaExtensions = z.infer<typeof VpaExtensions>;

export const DesignMdFrontMatter = z.object({
  name: z.string().min(1).max(80),
  version: z.number().int().positive(),
  description: z.string().optional(),
  colors: Colors,
  typography: Typography,
  rounded: Rounded,
  spacing: Spacing,
  components: z.record(z.string(), z.unknown()).default({}),
  vpa: VpaExtensions.optional(),
}).strict();

export type DesignMdFrontMatter = z.infer<typeof DesignMdFrontMatter>;

export const DesignMd = z.object({
  frontMatter: DesignMdFrontMatter,
  body: z.string(),                  // markdown body (everything after the closing ---)
});
export type DesignMd = z.infer<typeof DesignMd>;
```

- [ ] **Step 4: Run the test (must pass)**

Run: `npm --workspace packages/shared test -- design-md`
Expected: PASS, 4 tests passing.

- [ ] **Step 5: Implement Brand registry types**

Create `packages/shared/src/brand.ts`:

```typescript
import { z } from 'zod';
import { DesignMd } from './design-md.js';

export const BrandRegistryEntry = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'Slug: lowercase alphanumeric + hyphens, max 80 chars'),
  name: z.string().min(1).max(80),
  version: z.number().int().positive(),
  created: z.string(),
  updated: z.string(),
  forked_from: z.string().nullable(),
});
export type BrandRegistryEntry = z.infer<typeof BrandRegistryEntry>;

export const BrandRegistry = z.object({
  default_brand_id: z.string().nullable(),
  brands: z.array(BrandRegistryEntry),
}).refine(
  (r) => r.default_brand_id === null || r.brands.some((b) => b.id === r.default_brand_id),
  'default_brand_id must reference a brand in brands[]',
);
export type BrandRegistry = z.infer<typeof BrandRegistry>;

export const BrandWithDoc = z.object({
  registry: BrandRegistryEntry,
  doc: DesignMd,
});
export type BrandWithDoc = z.infer<typeof BrandWithDoc>;
```

- [ ] **Step 6: Extend Project schema with brand link**

Modify `packages/shared/src/project.ts` — add the `brand` field to the existing `Project` schema. Find the existing schema (created in Plan 01 Task 2) and add:

```typescript
// Inside the existing Project zod object, add:
brand: z.object({
  id: z.string(),
  applied_version: z.number().int().positive(),
}).nullable().default(null),
```

If the existing schema uses `.strict()` no further changes needed. If it doesn't, leave as-is.

- [ ] **Step 7: Re-export new modules**

Modify `packages/shared/src/index.ts` (add to existing re-exports):

```typescript
export * from './design-md.js';
export * from './brand.js';
```

- [ ] **Step 8: Run all shared tests (must pass)**

Run: `npm --workspace packages/shared test`
Expected: PASS — design-md tests pass, project tests still pass.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/design-md.ts packages/shared/src/design-md.test.ts \
        packages/shared/src/brand.ts packages/shared/src/project.ts \
        packages/shared/src/index.ts
git commit -m "feat(shared): design.md, Brand registry, and Project.brand schemas"
```

---

## Task 3: Document extraction — detect & MarkItDown subprocess

**Files:**
- Create: `apps/server/src/services/document-extract/detect.ts`
- Create: `apps/server/src/services/document-extract/detect.test.ts`
- Create: `apps/server/src/services/document-extract/markitdown.ts`
- Create: `apps/server/src/services/document-extract/markitdown.test.ts`

- [ ] **Step 1: Write failing test for detect()**

Create `apps/server/src/services/document-extract/detect.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { detectMarkItDown, _resetCache } from './detect.js';

vi.mock('node:child_process');

describe('detectMarkItDown', () => {
  beforeEach(() => { _resetCache(); vi.resetAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns available + version when markitdown --version succeeds', async () => {
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, 'markitdown 0.0.1a3\n', '');
      return {} as any;
    }) as any);
    const result = await detectMarkItDown();
    expect(result.available).toBe(true);
    expect(result.version).toBe('0.0.1a3');
  });

  it('returns unavailable when execFile errors', async () => {
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(new Error('ENOENT'), '', '');
      return {} as any;
    }) as any);
    const result = await detectMarkItDown();
    expect(result.available).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it('caches the result across calls', async () => {
    const spy = vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, _args: any, cb: any) => {
      cb(null, 'markitdown 0.0.1\n', '');
      return {} as any;
    }) as any);
    await detectMarkItDown();
    await detectMarkItDown();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test (must fail)**

Run: `npm --workspace apps/server test -- document-extract/detect`
Expected: FAIL with "Cannot find module './detect.js'"

- [ ] **Step 3: Implement detect.ts**

Create `apps/server/src/services/document-extract/detect.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface MarkItDownStatus {
  available: boolean;
  version?: string;
}

let cache: MarkItDownStatus | null = null;

export async function detectMarkItDown(): Promise<MarkItDownStatus> {
  if (cache) return cache;
  try {
    const { stdout } = await execFileP('markitdown', ['--version'], { timeout: 3000 });
    const match = stdout.match(/markitdown\s+(\S+)/i);
    cache = { available: true, version: match ? match[1] : 'unknown' };
  } catch {
    cache = { available: false };
  }
  return cache;
}

// Test-only escape hatch.
export function _resetCache(): void {
  cache = null;
}
```

- [ ] **Step 4: Run the test (must pass)**

Run: `npm --workspace apps/server test -- document-extract/detect`
Expected: PASS, 3 tests passing.

- [ ] **Step 5: Write failing test for markitdown.extract()**

Create `apps/server/src/services/document-extract/markitdown.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { extractWithMarkItDown } from './markitdown.js';

vi.mock('node:child_process');

describe('extractWithMarkItDown', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('runs markitdown <path> and returns stdout', async () => {
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, args: any, _opts: any, cb: any) => {
      expect(args[0]).toBe('/tmp/brand.pdf');
      cb(null, '# Brand Guide\n\nPrimary color: #0091DA', '');
      return {} as any;
    }) as any);
    const out = await extractWithMarkItDown('/tmp/brand.pdf');
    expect(out).toContain('# Brand Guide');
    expect(out).toContain('#0091DA');
  });

  it('throws on subprocess error', async () => {
    vi.spyOn(childProcess, 'execFile').mockImplementation(((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(new Error('exit 1'), '', 'failed to parse');
      return {} as any;
    }) as any);
    await expect(extractWithMarkItDown('/tmp/bad.pdf')).rejects.toThrow(/markitdown failed/);
  });
});
```

- [ ] **Step 6: Run the test (must fail)**

Run: `npm --workspace apps/server test -- markitdown.test`
Expected: FAIL with "Cannot find module './markitdown.js'"

- [ ] **Step 7: Implement markitdown.ts**

Create `apps/server/src/services/document-extract/markitdown.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 25 * 1024 * 1024; // 25 MB

export async function extractWithMarkItDown(path: string): Promise<string> {
  try {
    const { stdout } = await execFileP('markitdown', [path], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err: any) {
    throw new Error(`markitdown failed for ${path}: ${err.message}`);
  }
}
```

- [ ] **Step 8: Run the test (must pass)**

Run: `npm --workspace apps/server test -- markitdown.test`
Expected: PASS, 2 tests passing.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/services/document-extract/detect.ts \
        apps/server/src/services/document-extract/detect.test.ts \
        apps/server/src/services/document-extract/markitdown.ts \
        apps/server/src/services/document-extract/markitdown.test.ts
git commit -m "feat(extract): MarkItDown detection and subprocess wrapper"
```

---

## Task 4: Document extraction — fallbacks and orchestrator

**Files:**
- Create: `apps/server/src/services/document-extract/fallback-pdf.ts`
- Create: `apps/server/src/services/document-extract/fallback-pdf.test.ts`
- Create: `apps/server/src/services/document-extract/fallback-url.ts`
- Create: `apps/server/src/services/document-extract/fallback-url.test.ts`
- Create: `apps/server/src/services/document-extract/index.ts`
- Create: `apps/server/src/services/document-extract/index.test.ts`
- Modify: `apps/server/package.json` (add `pdf-parse`, `cheerio`, `@mozilla/readability`, `jsdom`)

- [ ] **Step 1: Add npm dependencies**

```bash
npm --workspace apps/server install pdf-parse@1 cheerio@1 @mozilla/readability@0.5 jsdom@24
npm --workspace apps/server install --save-dev @types/pdf-parse @types/jsdom
```

- [ ] **Step 2: Write failing test for fallback-pdf**

Create `apps/server/src/services/document-extract/fallback-pdf.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { extractPdfFallback } from './fallback-pdf.js';

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<any>('node:fs/promises');
  return { ...real, readFile: vi.fn() };
});

describe('extractPdfFallback', () => {
  it('produces markdown headings from page-break delimited text', async () => {
    // Pre-built buffer with two pages of plain text.
    (readFile as any).mockResolvedValue(Buffer.from('mock-pdf-bytes'));
    // We mock pdf-parse via its module entry; here we test the post-processing logic.
    // For this unit test we'll feed text directly via the lower-level helper.
    const out = await extractPdfFallback('/tmp/x.pdf', { __injectText: 'Page 1 text\f\nPage 2 text' });
    expect(out).toMatch(/Page 1 text/);
    expect(out).toMatch(/Page 2 text/);
  });
});
```

- [ ] **Step 3: Run the test (must fail)**

Run: `npm --workspace apps/server test -- fallback-pdf`
Expected: FAIL with "Cannot find module './fallback-pdf.js'"

- [ ] **Step 4: Implement fallback-pdf.ts**

Create `apps/server/src/services/document-extract/fallback-pdf.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import pdfParse from 'pdf-parse';

export interface FallbackPdfOptions {
  __injectText?: string; // test escape hatch — bypass pdf-parse
}

export async function extractPdfFallback(path: string, opts: FallbackPdfOptions = {}): Promise<string> {
  let text: string;
  if (opts.__injectText !== undefined) {
    text = opts.__injectText;
  } else {
    const buf = await readFile(path);
    const result = await pdfParse(buf);
    text = result.text;
  }
  // Normalize page breaks (\f) into markdown horizontal rules and trim runs of blank lines.
  return text
    .replace(/\f/g, '\n\n---\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n')
    .trim();
}
```

- [ ] **Step 5: Run the test (must pass)**

Run: `npm --workspace apps/server test -- fallback-pdf`
Expected: PASS.

- [ ] **Step 6: Write failing test for fallback-url**

Create `apps/server/src/services/document-extract/fallback-url.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractUrlFallback } from './fallback-url.js';

const SAMPLE_HTML = `
<!doctype html>
<html><head><title>Acme Brand</title></head>
<body>
  <header>nav stuff</header>
  <article>
    <h1>Acme Visual Identity</h1>
    <p>Our primary color is <strong>#FF6B35</strong>. We use Inter for headings.</p>
  </article>
  <footer>copyright</footer>
</body></html>
`;

describe('extractUrlFallback', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_HTML),
    } as any);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('strips chrome and returns the article body as markdown', async () => {
    const out = await extractUrlFallback('https://acme.example/brand');
    expect(out).toContain('Acme Visual Identity');
    expect(out).toContain('#FF6B35');
    expect(out).not.toContain('nav stuff');
    expect(out).not.toContain('copyright');
  });

  it('throws on non-OK response', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 404 } as any);
    await expect(extractUrlFallback('https://x.example')).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 7: Run the test (must fail)**

Run: `npm --workspace apps/server test -- fallback-url`
Expected: FAIL with "Cannot find module './fallback-url.js'"

- [ ] **Step 8: Implement fallback-url.ts**

Create `apps/server/src/services/document-extract/fallback-url.ts`:

```typescript
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const FETCH_TIMEOUT_MS = 30_000;

export async function extractUrlFallback(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'VPA-Brand-Extractor/1.0' } });
    if (!res.ok) throw new Error(`Fetch ${url} failed with status ${res.status}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article) {
    // Last-resort fallback: dump body text.
    return dom.window.document.body?.textContent?.trim() ?? '';
  }
  // Article has title, byline, content (HTML), textContent (plain). Convert to simple markdown.
  const md: string[] = [];
  if (article.title) md.push(`# ${article.title}`, '');
  if (article.byline) md.push(`*${article.byline}*`, '');
  md.push(article.textContent.trim());
  return md.join('\n');
}
```

- [ ] **Step 9: Run the test (must pass)**

Run: `npm --workspace apps/server test -- fallback-url`
Expected: PASS.

- [ ] **Step 10: Write failing test for the orchestrator**

Create `apps/server/src/services/document-extract/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extract } from './index.js';
import * as detect from './detect.js';
import * as md from './markitdown.js';
import * as fp from './fallback-pdf.js';
import * as fu from './fallback-url.js';

vi.mock('./detect.js');
vi.mock('./markitdown.js');
vi.mock('./fallback-pdf.js');
vi.mock('./fallback-url.js');

describe('extract orchestrator', () => {
  beforeEach(() => vi.resetAllMocks());

  it('uses MarkItDown when available for a PDF', async () => {
    (detect.detectMarkItDown as any).mockResolvedValue({ available: true, version: '0.0.1' });
    (md.extractWithMarkItDown as any).mockResolvedValue('# from markitdown');
    const out = await extract({ kind: 'file', path: '/tmp/x.pdf' });
    expect(out.markdown).toContain('from markitdown');
    expect(out.extractor).toBe('markitdown');
  });

  it('falls back to pdf-parse when MarkItDown is unavailable', async () => {
    (detect.detectMarkItDown as any).mockResolvedValue({ available: false });
    (fp.extractPdfFallback as any).mockResolvedValue('plain text from pdf');
    const out = await extract({ kind: 'file', path: '/tmp/x.pdf' });
    expect(out.markdown).toContain('plain text');
    expect(out.extractor).toBe('pdf-parse');
  });

  it('uses MarkItDown for URL when available', async () => {
    (detect.detectMarkItDown as any).mockResolvedValue({ available: true, version: '0.0.1' });
    (md.extractWithMarkItDown as any).mockResolvedValue('# url via markitdown');
    const out = await extract({ kind: 'url', url: 'https://x.example' });
    expect(out.extractor).toBe('markitdown');
  });

  it('falls back to readability for URL when MarkItDown unavailable', async () => {
    (detect.detectMarkItDown as any).mockResolvedValue({ available: false });
    (fu.extractUrlFallback as any).mockResolvedValue('article body');
    const out = await extract({ kind: 'url', url: 'https://x.example' });
    expect(out.extractor).toBe('readability');
  });

  it('reads markdown files directly without LLM extraction', async () => {
    const mockReadFile = vi.fn().mockResolvedValue('# Already markdown');
    const out = await extract({ kind: 'file', path: '/tmp/x.md' }, { __readFile: mockReadFile });
    expect(out.markdown).toBe('# Already markdown');
    expect(out.extractor).toBe('passthrough');
  });

  it('passes through free-text input', async () => {
    const out = await extract({ kind: 'text', text: 'My brand is bold and clean' });
    expect(out.markdown).toBe('My brand is bold and clean');
    expect(out.extractor).toBe('passthrough');
  });

  it('rejects unsupported file format with fallback path active', async () => {
    (detect.detectMarkItDown as any).mockResolvedValue({ available: false });
    await expect(extract({ kind: 'file', path: '/tmp/x.docx' })).rejects.toThrow(/MarkItDown/i);
  });
});
```

- [ ] **Step 11: Run the test (must fail)**

Run: `npm --workspace apps/server test -- document-extract/index`
Expected: FAIL with "Cannot find module './index.js'"

- [ ] **Step 12: Implement the orchestrator**

Create `apps/server/src/services/document-extract/index.ts`:

```typescript
import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { detectMarkItDown } from './detect.js';
import { extractWithMarkItDown } from './markitdown.js';
import { extractPdfFallback } from './fallback-pdf.js';
import { extractUrlFallback } from './fallback-url.js';

export type ExtractInput =
  | { kind: 'file'; path: string }
  | { kind: 'url';  url: string }
  | { kind: 'text'; text: string };

export interface ExtractResult {
  markdown: string;
  extractor: 'markitdown' | 'pdf-parse' | 'readability' | 'passthrough';
}

export interface ExtractOptions {
  __readFile?: typeof readFile; // test injection point
}

const PASSTHROUGH_EXTS = new Set(['.md', '.markdown', '.txt', '.yaml', '.yml']);

export async function extract(input: ExtractInput, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const readFn = opts.__readFile ?? readFile;

  if (input.kind === 'text') {
    return { markdown: input.text, extractor: 'passthrough' };
  }

  if (input.kind === 'file') {
    const ext = extname(input.path).toLowerCase();
    if (PASSTHROUGH_EXTS.has(ext)) {
      const content = await readFn(input.path, 'utf8');
      return { markdown: content as string, extractor: 'passthrough' };
    }
    const status = await detectMarkItDown();
    if (status.available) {
      return { markdown: await extractWithMarkItDown(input.path), extractor: 'markitdown' };
    }
    if (ext === '.pdf') {
      return { markdown: await extractPdfFallback(input.path), extractor: 'pdf-parse' };
    }
    throw new Error(`Format ${ext} requires MarkItDown. Install: pip install markitdown[all]`);
  }

  // input.kind === 'url'
  const status = await detectMarkItDown();
  if (status.available) {
    return { markdown: await extractWithMarkItDown(input.url), extractor: 'markitdown' };
  }
  return { markdown: await extractUrlFallback(input.url), extractor: 'readability' };
}
```

- [ ] **Step 13: Run all extraction tests (must pass)**

Run: `npm --workspace apps/server test -- document-extract`
Expected: PASS, all extraction tests passing.

- [ ] **Step 14: Commit**

```bash
git add apps/server/package.json apps/server/package-lock.json \
        apps/server/src/services/document-extract/
git commit -m "feat(extract): pdf-parse + readability fallbacks and dispatch orchestrator"
```

---

## Task 5: Brand registry (brands.json)

**Files:**
- Create: `apps/server/src/services/brand/paths.ts`
- Create: `apps/server/src/services/brand/registry.ts`
- Create: `apps/server/src/services/brand/registry.test.ts`

- [ ] **Step 1: Write the path helper**

Create `apps/server/src/services/brand/paths.ts`:

```typescript
import { join } from 'node:path';

export interface BrandPaths {
  registryFile: string;       // .vpa/brands.json
  brandsRoot: string;         // brands/
  brandDir(slug: string): string;
  designMd(slug: string): string;
  parentJson(slug: string): string;
  assetsDir(slug: string): string;
  sourceDocsDir(slug: string): string;
  extractedTextMd(slug: string): string;
  sourcesJson(slug: string): string;
}

export function brandPaths(workspaceRoot: string, vpaDir: string): BrandPaths {
  const brandsRoot = join(workspaceRoot, 'brands');
  return {
    registryFile: join(vpaDir, 'brands.json'),
    brandsRoot,
    brandDir:        (slug) => join(brandsRoot, slug),
    designMd:        (slug) => join(brandsRoot, slug, 'design.md'),
    parentJson:      (slug) => join(brandsRoot, slug, 'parent.json'),
    assetsDir:       (slug) => join(brandsRoot, slug, 'assets'),
    sourceDocsDir:   (slug) => join(brandsRoot, slug, 'assets', 'source-docs'),
    extractedTextMd: (slug) => join(brandsRoot, slug, 'assets', 'source-docs', 'extracted-text.md'),
    sourcesJson:     (slug) => join(brandsRoot, slug, 'assets', 'source-docs', 'sources.json'),
  };
}
```

- [ ] **Step 2: Write failing tests for the registry**

Create `apps/server/src/services/brand/registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegistry, writeRegistry, addEntry, updateEntry, removeEntry, setDefault } from './registry.js';

let tmp: string;
let registryFile: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-brand-'));
  registryFile = join(tmp, 'brands.json');
});

describe('registry', () => {
  it('returns an empty registry when file does not exist', async () => {
    const r = await readRegistry(registryFile);
    expect(r).toEqual({ default_brand_id: null, brands: [] });
  });

  it('round-trips through write + read', async () => {
    await writeRegistry(registryFile, { default_brand_id: null, brands: [] });
    const r = await readRegistry(registryFile);
    expect(r.brands).toEqual([]);
  });

  it('addEntry appends and updates', async () => {
    await addEntry(registryFile, {
      id: 'tanzu', name: 'Tanzu', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    });
    const r = await readRegistry(registryFile);
    expect(r.brands).toHaveLength(1);
    expect(r.brands[0].id).toBe('tanzu');
  });

  it('addEntry rejects duplicate slug', async () => {
    const entry = {
      id: 'tanzu', name: 'Tanzu', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    };
    await addEntry(registryFile, entry);
    await expect(addEntry(registryFile, entry)).rejects.toThrow(/already exists/);
  });

  it('updateEntry bumps version and updated timestamp', async () => {
    await addEntry(registryFile, {
      id: 'tanzu', name: 'Tanzu', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    });
    await updateEntry(registryFile, 'tanzu', { version: 2 });
    const r = await readRegistry(registryFile);
    expect(r.brands[0].version).toBe(2);
    expect(r.brands[0].updated).not.toBe('2026-04-30T00:00:00Z');
  });

  it('setDefault enforces single-default invariant', async () => {
    await addEntry(registryFile, {
      id: 'a', name: 'A', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    });
    await addEntry(registryFile, {
      id: 'b', name: 'B', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    });
    await setDefault(registryFile, 'a');
    expect((await readRegistry(registryFile)).default_brand_id).toBe('a');
    await setDefault(registryFile, 'b');
    expect((await readRegistry(registryFile)).default_brand_id).toBe('b');
    await setDefault(registryFile, null);
    expect((await readRegistry(registryFile)).default_brand_id).toBeNull();
  });

  it('removeEntry clears default if the removed brand was default', async () => {
    await addEntry(registryFile, {
      id: 'a', name: 'A', version: 1,
      created: '2026-04-30T00:00:00Z', updated: '2026-04-30T00:00:00Z',
      forked_from: null,
    });
    await setDefault(registryFile, 'a');
    await removeEntry(registryFile, 'a');
    const r = await readRegistry(registryFile);
    expect(r.brands).toEqual([]);
    expect(r.default_brand_id).toBeNull();
  });

  it('readRegistry rejects malformed file', async () => {
    await writeFile(registryFile, '{ broken json', 'utf8');
    await expect(readRegistry(registryFile)).rejects.toThrow();
  });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// Dummy import to keep TS satisfied at top level — vitest's `afterEach` available.
import { afterEach } from 'vitest';
```

- [ ] **Step 3: Run the test (must fail)**

Run: `npm --workspace apps/server test -- brand/registry`
Expected: FAIL with "Cannot find module './registry.js'"

- [ ] **Step 4: Implement registry.ts**

Create `apps/server/src/services/brand/registry.ts`:

```typescript
import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BrandRegistry, BrandRegistryEntry } from '@vpa/shared';
import { writeAtomic } from '../../lib/fs-atomic.js';

const EMPTY: BrandRegistry = { default_brand_id: null, brands: [] };

export async function readRegistry(path: string): Promise<BrandRegistry> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return EMPTY;
    throw err;
  }
  return BrandRegistry.parse(JSON.parse(raw));
}

export async function writeRegistry(path: string, registry: BrandRegistry): Promise<void> {
  // Validate before writing.
  BrandRegistry.parse(registry);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, JSON.stringify(registry, null, 2) + '\n');
}

export async function addEntry(path: string, entry: BrandRegistryEntry): Promise<void> {
  const reg = await readRegistry(path);
  if (reg.brands.some((b) => b.id === entry.id)) {
    throw new Error(`Brand "${entry.id}" already exists`);
  }
  reg.brands.push(BrandRegistryEntry.parse(entry));
  await writeRegistry(path, reg);
}

export async function updateEntry(
  path: string,
  id: string,
  patch: Partial<Omit<BrandRegistryEntry, 'id' | 'created' | 'forked_from'>>,
): Promise<BrandRegistryEntry> {
  const reg = await readRegistry(path);
  const idx = reg.brands.findIndex((b) => b.id === id);
  if (idx < 0) throw new Error(`Brand "${id}" not found`);
  const next = { ...reg.brands[idx], ...patch, updated: new Date().toISOString() };
  reg.brands[idx] = BrandRegistryEntry.parse(next);
  await writeRegistry(path, reg);
  return reg.brands[idx];
}

export async function removeEntry(path: string, id: string): Promise<void> {
  const reg = await readRegistry(path);
  reg.brands = reg.brands.filter((b) => b.id !== id);
  if (reg.default_brand_id === id) reg.default_brand_id = null;
  await writeRegistry(path, reg);
}

export async function setDefault(path: string, id: string | null): Promise<void> {
  const reg = await readRegistry(path);
  if (id !== null && !reg.brands.some((b) => b.id === id)) {
    throw new Error(`Cannot set default: brand "${id}" not found`);
  }
  reg.default_brand_id = id;
  await writeRegistry(path, reg);
}
```

- [ ] **Step 5: Run the test (must pass)**

Run: `npm --workspace apps/server test -- brand/registry`
Expected: PASS, 8 tests passing.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/brand/paths.ts \
        apps/server/src/services/brand/registry.ts \
        apps/server/src/services/brand/registry.test.ts
git commit -m "feat(brand): registry with single-default invariant"
```

---

## Task 6: Brand store — directory operations and design.md I/O

**Files:**
- Create: `apps/server/src/services/brand/store.ts`
- Create: `apps/server/src/services/brand/store.test.ts`
- Modify: `apps/server/package.json` (add `gray-matter`, `js-yaml` already present)

- [ ] **Step 1: Add gray-matter dependency**

```bash
npm --workspace apps/server install gray-matter@4
```

- [ ] **Step 2: Write failing tests for the store**

Create `apps/server/src/services/brand/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandPaths } from './paths.js';
import { createBrand, readBrand, updateBrandDoc, deleteBrand, listBrands } from './store.js';

let tmp: string;
let paths: ReturnType<typeof brandPaths>;
let registryFile: string;

const SAMPLE_FRONTMATTER = {
  name: 'Tanzu',
  version: 1,
  colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
  typography: {
    heading: { family: 'Inter', weights: [600, 700] },
    body: { family: 'Inter', weights: [400, 500] },
  },
  rounded: { sm: 4, md: 8, lg: 16 },
  spacing: { unit: 8, scale: [4, 8, 16, 24, 32] },
  components: {},
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-store-'));
  await mkdir(join(tmp, '.vpa'), { recursive: true });
  paths = brandPaths(tmp, join(tmp, '.vpa'));
  registryFile = paths.registryFile;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('brand store', () => {
  it('createBrand creates directory tree and writes design.md + registry entry', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu',
      name: 'Tanzu',
      frontMatter: SAMPLE_FRONTMATTER,
      body: '## Overview\n\nTanzu is...',
    });

    const written = await readFile(paths.designMd('tanzu'), 'utf8');
    expect(written).toMatch(/^---\n/);
    expect(written).toMatch(/name: Tanzu/);
    expect(written).toMatch(/## Overview/);

    const list = await listBrands(registryFile);
    expect(list.brands).toHaveLength(1);
    expect(list.brands[0].id).toBe('tanzu');
  });

  it('readBrand parses design.md and returns BrandWithDoc', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Overview',
    });
    const brand = await readBrand(paths, registryFile, 'tanzu');
    expect(brand.registry.id).toBe('tanzu');
    expect(brand.doc.frontMatter.name).toBe('Tanzu');
    expect(brand.doc.body).toContain('## Overview');
  });

  it('readBrand throws when brand does not exist', async () => {
    await expect(readBrand(paths, registryFile, 'missing')).rejects.toThrow(/not found/);
  });

  it('updateBrandDoc bumps version and writes new content', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Old',
    });
    await updateBrandDoc(paths, registryFile, 'tanzu', {
      frontMatter: { ...SAMPLE_FRONTMATTER, version: 2 },
      body: '## New',
    });
    const updated = await readBrand(paths, registryFile, 'tanzu');
    expect(updated.registry.version).toBe(2);
    expect(updated.doc.body).toContain('## New');
  });

  it('updateBrandDoc rejects version that does not increment', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Old',
    });
    await expect(updateBrandDoc(paths, registryFile, 'tanzu', {
      frontMatter: { ...SAMPLE_FRONTMATTER, version: 1 },
      body: '## Same',
    })).rejects.toThrow(/version must increment/);
  });

  it('deleteBrand removes directory and registry entry', async () => {
    await createBrand(paths, registryFile, {
      slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Overview',
    });
    await deleteBrand(paths, registryFile, 'tanzu');
    expect((await listBrands(registryFile)).brands).toEqual([]);
    await expect(readFile(paths.designMd('tanzu'), 'utf8')).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the test (must fail)**

Run: `npm --workspace apps/server test -- brand/store`
Expected: FAIL with "Cannot find module './store.js'"

- [ ] **Step 4: Implement store.ts**

Create `apps/server/src/services/brand/store.ts`:

```typescript
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { BrandRegistry, BrandWithDoc, DesignMd, DesignMdFrontMatter } from '@vpa/shared';
import { writeAtomic } from '../../lib/fs-atomic.js';
import type { BrandPaths } from './paths.js';
import {
  readRegistry, writeRegistry, addEntry, updateEntry, removeEntry,
} from './registry.js';

export interface CreateBrandInput {
  slug: string;
  name: string;
  frontMatter: DesignMdFrontMatter;
  body: string;
  forkedFrom?: string | null;
}

export async function createBrand(
  paths: BrandPaths,
  registryFile: string,
  input: CreateBrandInput,
): Promise<BrandWithDoc> {
  // Validate front matter strictly.
  DesignMdFrontMatter.parse(input.frontMatter);

  await mkdir(paths.brandDir(input.slug), { recursive: true });
  await mkdir(paths.assetsDir(input.slug), { recursive: true });
  await mkdir(paths.sourceDocsDir(input.slug), { recursive: true });

  const now = new Date().toISOString();
  const text = serializeDesignMd(input.frontMatter, input.body);
  await writeAtomic(paths.designMd(input.slug), text);

  if (input.forkedFrom) {
    await writeAtomic(
      paths.parentJson(input.slug),
      JSON.stringify({ forked_from: input.forkedFrom, forked_at: now }, null, 2) + '\n',
    );
  }

  await addEntry(registryFile, {
    id: input.slug,
    name: input.name,
    version: input.frontMatter.version,
    created: now,
    updated: now,
    forked_from: input.forkedFrom ?? null,
  });

  return readBrand(paths, registryFile, input.slug);
}

export async function readBrand(
  paths: BrandPaths,
  registryFile: string,
  slug: string,
): Promise<BrandWithDoc> {
  const reg = await readRegistry(registryFile);
  const entry = reg.brands.find((b) => b.id === slug);
  if (!entry) throw new Error(`Brand "${slug}" not found`);

  const raw = await readFile(paths.designMd(slug), 'utf8');
  const parsed = matter(raw, {
    engines: {
      yaml: { parse: (s) => yaml.load(s) as object, stringify: (o) => yaml.dump(o) },
    },
  });
  const doc: DesignMd = {
    frontMatter: DesignMdFrontMatter.parse(parsed.data),
    body: parsed.content.trimStart(),
  };
  return { registry: entry, doc };
}

export interface UpdateBrandDocInput {
  frontMatter: DesignMdFrontMatter;
  body: string;
}

export async function updateBrandDoc(
  paths: BrandPaths,
  registryFile: string,
  slug: string,
  input: UpdateBrandDocInput,
): Promise<BrandWithDoc> {
  const current = await readBrand(paths, registryFile, slug);
  if (input.frontMatter.version <= current.registry.version) {
    throw new Error(
      `Brand version must increment (current=${current.registry.version}, attempted=${input.frontMatter.version})`,
    );
  }
  DesignMdFrontMatter.parse(input.frontMatter);
  await writeAtomic(paths.designMd(slug), serializeDesignMd(input.frontMatter, input.body));
  await updateEntry(registryFile, slug, { version: input.frontMatter.version, name: input.frontMatter.name });
  return readBrand(paths, registryFile, slug);
}

export async function deleteBrand(
  paths: BrandPaths,
  registryFile: string,
  slug: string,
): Promise<void> {
  await rm(paths.brandDir(slug), { recursive: true, force: true });
  await removeEntry(registryFile, slug);
}

export async function listBrands(registryFile: string): Promise<BrandRegistry> {
  return readRegistry(registryFile);
}

// Helper — serialize front matter + body into design.md text.
function serializeDesignMd(fm: DesignMdFrontMatter, body: string): string {
  const yamlText = yaml.dump(fm, { lineWidth: 100, noRefs: true });
  return `---\n${yamlText}---\n\n${body.trimStart()}\n`;
}
```

- [ ] **Step 5: Run the test (must pass)**

Run: `npm --workspace apps/server test -- brand/store`
Expected: PASS, 6 tests passing.

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json apps/server/package-lock.json \
        apps/server/src/services/brand/store.ts \
        apps/server/src/services/brand/store.test.ts
git commit -m "feat(brand): store with create/read/update/delete and version-bump invariant"
```

---

## Task 7: Brand fork

**Files:**
- Create: `apps/server/src/services/brand/fork.ts`
- Create: `apps/server/src/services/brand/fork.test.ts`

- [ ] **Step 1: Write failing tests for fork**

Create `apps/server/src/services/brand/fork.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandPaths } from './paths.js';
import { createBrand, readBrand } from './store.js';
import { forkBrand } from './fork.js';

let tmp: string;
let paths: ReturnType<typeof brandPaths>;
let registryFile: string;

const SAMPLE_FRONTMATTER = {
  name: 'Tanzu',
  version: 1,
  colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
  typography: {
    heading: { family: 'Inter', weights: [600] },
    body: { family: 'Inter', weights: [400] },
  },
  rounded: { sm: 4, md: 8, lg: 16 },
  spacing: { unit: 8, scale: [4, 8] },
  components: {},
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-fork-'));
  await mkdir(join(tmp, '.vpa'), { recursive: true });
  paths = brandPaths(tmp, join(tmp, '.vpa'));
  registryFile = paths.registryFile;
  await createBrand(paths, registryFile, {
    slug: 'tanzu', name: 'Tanzu', frontMatter: SAMPLE_FRONTMATTER, body: '## Overview',
  });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('forkBrand', () => {
  it('creates a new brand directory with parent.json and forked_from set', async () => {
    const fork = await forkBrand(paths, registryFile, 'tanzu', { name: 'Tanzu · Q4 Launch' });
    expect(fork.registry.id).toBe('tanzu--q4-launch');
    expect(fork.registry.forked_from).toBe('tanzu');
    expect(fork.registry.version).toBe(1); // forks start at v1
    const parent = JSON.parse(await readFile(paths.parentJson('tanzu--q4-launch'), 'utf8'));
    expect(parent.forked_from).toBe('tanzu');
  });

  it('copies design.md from parent', async () => {
    const fork = await forkBrand(paths, registryFile, 'tanzu', { name: 'Tanzu · Copy' });
    const refetched = await readBrand(paths, registryFile, fork.registry.id);
    expect(refetched.doc.frontMatter.colors.primary).toBe('#0091DA');
    expect(refetched.doc.body).toContain('## Overview');
  });

  it('handles slug collisions by appending a numeric suffix', async () => {
    await forkBrand(paths, registryFile, 'tanzu', { name: 'Tanzu · Copy' });
    const second = await forkBrand(paths, registryFile, 'tanzu', { name: 'Tanzu · Copy' });
    expect(second.registry.id).toBe('tanzu--copy-2');
  });

  it('rejects forking a non-existent parent', async () => {
    await expect(forkBrand(paths, registryFile, 'missing', { name: 'X' })).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run the test (must fail)**

Run: `npm --workspace apps/server test -- brand/fork`
Expected: FAIL with "Cannot find module './fork.js'"

- [ ] **Step 3: Implement fork.ts**

Create `apps/server/src/services/brand/fork.ts`:

```typescript
import { BrandWithDoc, DesignMdFrontMatter } from '@vpa/shared';
import type { BrandPaths } from './paths.js';
import { createBrand, readBrand } from './store.js';
import { readRegistry } from './registry.js';

export interface ForkBrandInput {
  name: string;
}

export async function forkBrand(
  paths: BrandPaths,
  registryFile: string,
  parentSlug: string,
  input: ForkBrandInput,
): Promise<BrandWithDoc> {
  const parent = await readBrand(paths, registryFile, parentSlug);

  const baseSlug = derivedSlug(parentSlug, input.name);
  const reg = await readRegistry(registryFile);
  const existingSlugs = new Set(reg.brands.map((b) => b.id));
  const slug = uniqueSlug(baseSlug, existingSlugs);

  // Fork starts at version 1 with the parent's content; the new brand is a fresh entity.
  const forkedFrontMatter: DesignMdFrontMatter = {
    ...parent.doc.frontMatter,
    name: input.name,
    version: 1,
  };

  return createBrand(paths, registryFile, {
    slug,
    name: input.name,
    frontMatter: forkedFrontMatter,
    body: parent.doc.body,
    forkedFrom: parentSlug,
  });
}

function derivedSlug(parentSlug: string, name: string): string {
  // Take the trailing portion of the new name (after the last separator) and slugify.
  const tail = name.split(/[·•|\-—]/).pop()?.trim() ?? name;
  const slugified = slugify(tail);
  return slugified ? `${parentSlug}--${slugified}` : `${parentSlug}--copy`;
}

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('Could not generate unique slug after 1000 attempts');
}
```

- [ ] **Step 4: Run the test (must pass)**

Run: `npm --workspace apps/server test -- brand/fork`
Expected: PASS, 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/brand/fork.ts \
        apps/server/src/services/brand/fork.test.ts
git commit -m "feat(brand): fork-on-edit with parent.json lineage"
```

---

## Task 8: Brand validation (schema + contrast)

**Files:**
- Create: `apps/server/src/services/brand/validate.ts`
- Create: `apps/server/src/services/brand/validate.test.ts`
- Modify: `apps/server/package.json` (add `wcag-contrast`)

- [ ] **Step 1: Add wcag-contrast dependency**

```bash
npm --workspace apps/server install wcag-contrast@3
npm --workspace apps/server install --save-dev @types/wcag-contrast
```

If `@types/wcag-contrast` isn't published, declare a local stub. Add `apps/server/src/types/wcag-contrast.d.ts`:

```typescript
declare module 'wcag-contrast' {
  export function hex(a: string, b: string): number;
  export function score(ratio: number): 'Fail' | 'AA Large' | 'AA' | 'AAA';
}
```

- [ ] **Step 2: Write failing tests**

Create `apps/server/src/services/brand/validate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateBrand, BRAND_OK, BrandValidationIssue } from './validate.js';

const OK_FRONTMATTER = {
  name: 'Tanzu',
  version: 1,
  colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
  typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
  rounded: { sm: 4, md: 8, lg: 16 },
  spacing: { unit: 8, scale: [4, 8, 16] },
  components: {},
};

describe('validateBrand', () => {
  it('returns BRAND_OK for valid brand with safe contrast', () => {
    const result = validateBrand({ frontMatter: OK_FRONTMATTER, body: '## Overview' });
    expect(result.status).toBe(BRAND_OK);
    expect(result.warnings).toEqual([]);
  });

  it('warns when on_surface on surface fails AA', () => {
    const fm = { ...OK_FRONTMATTER, colors: { primary: '#0091DA', surface: '#CCCCCC', on_surface: '#AAAAAA' } };
    const result = validateBrand({ frontMatter: fm, body: '' });
    expect(result.status).toBe(BRAND_OK);
    const contrastWarnings = result.warnings.filter((w: BrandValidationIssue) => w.code === 'low-contrast');
    expect(contrastWarnings.length).toBeGreaterThan(0);
  });

  it('returns errors when front matter fails schema', () => {
    const fm = { ...OK_FRONTMATTER, colors: { primary: 'not-hex', surface: '#FFF', on_surface: '#000' } };
    const result = validateBrand({ frontMatter: fm as any, body: '' });
    expect(result.status).toBe('invalid');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('resolves {colors.x} references in lower_thirds for contrast check', () => {
    const fm = {
      ...OK_FRONTMATTER,
      vpa: {
        voice: { tone: 'x', avoid: [] },
        audio: { music_mood: null, sonic_logo: null },
        logo: { primary: null, mono: null, safe_zone_ratio: 0.25 },
        lower_thirds: { template: 'bar-left-accent' as const, bg: '{colors.surface}', fg: '{colors.surface}' },
        taglines: [],
      },
    };
    const result = validateBrand({ frontMatter: fm, body: '' });
    const ltContrast = result.warnings.find((w: BrandValidationIssue) => w.code === 'low-contrast' && w.field?.startsWith('vpa.lower_thirds'));
    expect(ltContrast).toBeDefined();
  });
});
```

- [ ] **Step 3: Run the test (must fail)**

Run: `npm --workspace apps/server test -- brand/validate`
Expected: FAIL.

- [ ] **Step 4: Implement validate.ts**

Create `apps/server/src/services/brand/validate.ts`:

```typescript
import { hex as contrastRatio } from 'wcag-contrast';
import { DesignMd, DesignMdFrontMatter } from '@vpa/shared';

export const BRAND_OK = 'ok' as const;
export type ValidationStatus = typeof BRAND_OK | 'invalid';

export interface BrandValidationIssue {
  code: string;            // e.g. 'low-contrast', 'schema'
  message: string;
  field?: string;
  ratio?: number;          // for contrast issues
}

export interface BrandValidationResult {
  status: ValidationStatus;
  errors: BrandValidationIssue[];
  warnings: BrandValidationIssue[];
}

const AA_NORMAL = 4.5;

export function validateBrand(doc: DesignMd): BrandValidationResult {
  const errors: BrandValidationIssue[] = [];
  const warnings: BrandValidationIssue[] = [];

  // 1. Schema validation.
  const parsed = DesignMdFrontMatter.safeParse(doc.frontMatter);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ code: 'schema', message: issue.message, field: issue.path.join('.') });
    }
    return { status: 'invalid', errors, warnings };
  }
  const fm = parsed.data;

  // 2. Contrast: on_surface vs surface.
  const baseRatio = contrastRatio(fm.colors.on_surface, fm.colors.surface);
  if (baseRatio < AA_NORMAL) {
    warnings.push({
      code: 'low-contrast',
      message: `on_surface on surface fails WCAG AA (${baseRatio.toFixed(2)}:1, target ${AA_NORMAL}:1)`,
      field: 'colors.on_surface',
      ratio: baseRatio,
    });
  }

  // 3. Contrast: lower_thirds fg/bg, resolving {colors.x} references.
  if (fm.vpa) {
    const fg = resolveColor(fm.vpa.lower_thirds.fg, fm.colors);
    const bg = resolveColor(fm.vpa.lower_thirds.bg, fm.colors);
    if (fg && bg) {
      const ratio = contrastRatio(fg, bg);
      if (ratio < AA_NORMAL) {
        warnings.push({
          code: 'low-contrast',
          message: `lower_thirds fg on bg fails WCAG AA (${ratio.toFixed(2)}:1, target ${AA_NORMAL}:1)`,
          field: 'vpa.lower_thirds.fg',
          ratio,
        });
      }
    }
  }

  return { status: BRAND_OK, errors, warnings };
}

function resolveColor(value: string, colors: Record<string, string>): string | null {
  const ref = value.match(/^\{colors\.([a-z_]+)\}$/);
  if (ref) return colors[ref[1]] ?? null;
  if (/^#[0-9A-Fa-f]{6,8}$/.test(value)) return value;
  return null;
}
```

- [ ] **Step 5: Run the test (must pass)**

Run: `npm --workspace apps/server test -- brand/validate`
Expected: PASS, 4 tests passing.

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json apps/server/package-lock.json \
        apps/server/src/types/wcag-contrast.d.ts \
        apps/server/src/services/brand/validate.ts \
        apps/server/src/services/brand/validate.test.ts
git commit -m "feat(brand): schema + WCAG contrast validation with token-reference resolution"
```

---

## Task 9: LLM service interface + fake provider + editable prompts

**Files:**
- Create: `apps/server/src/services/llm/index.ts`
- Create: `apps/server/src/services/llm/fake.ts`
- Create: `apps/server/src/services/llm/fake.test.ts`
- Create: `apps/server/src/services/llm/prompts.ts`
- Create: `apps/server/src/services/llm/prompts.test.ts`
- Create: `prompts/brand-extract-tokens.md`
- Create: `prompts/brand-write-rationale.md`

- [ ] **Step 1: Create the LLM client interface**

Create `apps/server/src/services/llm/index.ts`:

```typescript
export interface LlmCompletion {
  text: string;
  raw?: unknown;
}

export interface LlmCompleteOptions {
  systemPrompt: string;
  userPrompt: string;
  responseFormat?: 'text' | 'json';
  temperature?: number;
  maxTokens?: number;
}

export interface LlmClient {
  complete(opts: LlmCompleteOptions): Promise<LlmCompletion>;
}

export { createFakeLlm } from './fake.js';
export { loadPrompt } from './prompts.js';
```

- [ ] **Step 2: Write the editable prompt for token extraction**

Create `prompts/brand-extract-tokens.md`:

````markdown
You are a design-token extraction assistant. The user will provide one or more brand-related documents (markdown text extracted from PDFs, websites, or written notes). Your task is to extract design tokens and produce a strict JSON object that conforms to the **DesignMdFrontMatter** schema below.

## Output requirements

- Output **only** a single JSON object — no commentary, no code fences.
- Every required field must be present.
- Hex colors must be `#RRGGBB` (uppercase) format.
- Font weights must be 100, 200, 300, 400, 500, 600, 700, 800, or 900.
- If a field cannot be inferred, choose a sensible default consistent with the brand's apparent style and continue.

## Schema (target shape)

```json
{
  "name": "<brand name as string>",
  "version": 1,
  "description": "<one-line description of the brand>",
  "colors": {
    "primary":    "#RRGGBB",
    "accent":     "#RRGGBB",
    "surface":    "#RRGGBB",
    "on_surface": "#RRGGBB"
  },
  "typography": {
    "heading": { "family": "Inter", "weights": [600, 700] },
    "body":    { "family": "Inter", "weights": [400, 500] }
  },
  "rounded": { "sm": 4, "md": 8, "lg": 16 },
  "spacing": { "unit": 8, "scale": [4, 8, 16, 24, 32, 48] },
  "components": {},
  "vpa": {
    "voice": { "tone": "<short tone descriptor>", "avoid": ["<list of words/phrases to avoid>"] },
    "audio": { "music_mood": "<descriptor or null>", "sonic_logo": null },
    "logo":  { "primary": null, "mono": null, "safe_zone_ratio": 0.25 },
    "lower_thirds": { "template": "bar-left-accent", "bg": "{colors.primary}", "fg": "{colors.on_surface}" },
    "taglines": ["<tagline if found>"]
  }
}
```

## Few-shot example

**Input excerpt:**

> Acme Heritage uses a deep navy (#1B365D) as our primary identity color, paired with a warm Boston Clay (#B8422E) accent. Our type system is built on Public Sans, weight 400 for body and 700 for headings. Our voice is approachable, civic, and clear — never corporate or jargon-heavy.

**Expected output:**

```json
{
  "name": "Acme Heritage",
  "version": 1,
  "description": "Civic, approachable, clear",
  "colors": { "primary": "#1B365D", "accent": "#B8422E", "surface": "#FFFFFF", "on_surface": "#1A1C1E" },
  "typography": {
    "heading": { "family": "Public Sans", "weights": [700] },
    "body":    { "family": "Public Sans", "weights": [400] }
  },
  "rounded": { "sm": 4, "md": 8, "lg": 16 },
  "spacing": { "unit": 8, "scale": [4, 8, 16, 24, 32] },
  "components": {},
  "vpa": {
    "voice": { "tone": "Approachable, civic, clear", "avoid": ["corporate", "jargon"] },
    "audio": { "music_mood": null, "sonic_logo": null },
    "logo":  { "primary": null, "mono": null, "safe_zone_ratio": 0.25 },
    "lower_thirds": { "template": "bar-left-accent", "bg": "{colors.primary}", "fg": "{colors.surface}" },
    "taglines": []
  }
}
```
````

- [ ] **Step 3: Write the editable prompt for rationale writing**

Create `prompts/brand-write-rationale.md`:

````markdown
You are a brand-rationale writer. The user will provide finalized design tokens (front matter from a design.md). Produce the **markdown body** of the design.md — prose that explains the brand's design rationale.

## Output requirements

- Output **only** the markdown body. Do not repeat the front matter. Do not wrap in code fences.
- Follow this exact section order with `##` headings: Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts, Voice & Tone, Audio, Logo Usage.
- Each section: 1–3 short paragraphs. Be specific to this brand's tokens. Use the brand voice/tone described in `vpa.voice` to flavor your writing.
- For Colors, name each color and describe when to use it.
- For Typography, describe the role of heading vs body and any pairing rules.
- For Voice & Tone, expand `vpa.voice.tone` into a short paragraph plus a Do/Don't pair.
- For Audio and Logo Usage, ground recommendations in `vpa.audio` and `vpa.logo` if values are present; otherwise describe expected defaults.

## Voice direction

Match the tone described in `vpa.voice.tone`. If it says "confident, technical, optimistic", write that way. Avoid hedging, throat-clearing, and meta-commentary about your output.
````

- [ ] **Step 4: Write failing test for prompts loader**

Create `apps/server/src/services/llm/prompts.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrompt } from './prompts.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-prompt-'));
  await mkdir(join(tmp, 'prompts'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('loadPrompt', () => {
  it('reads a prompt file from the prompts directory', async () => {
    await writeFile(join(tmp, 'prompts', 'foo.md'), '# system\nhello', 'utf8');
    const text = await loadPrompt(tmp, 'foo');
    expect(text).toBe('# system\nhello');
  });

  it('throws a clear error when prompt missing', async () => {
    await expect(loadPrompt(tmp, 'missing')).rejects.toThrow(/prompts\/missing\.md/);
  });
});
```

- [ ] **Step 5: Run the test (must fail)**

Run: `npm --workspace apps/server test -- llm/prompts`
Expected: FAIL with "Cannot find module './prompts.js'"

- [ ] **Step 6: Implement prompts.ts**

Create `apps/server/src/services/llm/prompts.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadPrompt(workspaceRoot: string, name: string): Promise<string> {
  const path = join(workspaceRoot, 'prompts', `${name}.md`);
  try {
    return await readFile(path, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Prompt not found: prompts/${name}.md`);
    }
    throw err;
  }
}
```

- [ ] **Step 7: Run the test (must pass)**

Run: `npm --workspace apps/server test -- llm/prompts`
Expected: PASS, 2 tests passing.

- [ ] **Step 8: Write failing test for fake LLM provider**

Create `apps/server/src/services/llm/fake.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createFakeLlm } from './fake.js';

describe('createFakeLlm', () => {
  it('returns a deterministic JSON design.md when prompt asks for tokens', async () => {
    const llm = createFakeLlm();
    const out = await llm.complete({
      systemPrompt: 'extract design tokens',
      userPrompt: 'My brand is bold and clean',
      responseFormat: 'json',
    });
    const parsed = JSON.parse(out.text);
    expect(parsed.name).toBeDefined();
    expect(parsed.colors.primary).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(parsed.vpa).toBeDefined();
  });

  it('returns prose markdown when responseFormat is text', async () => {
    const llm = createFakeLlm();
    const out = await llm.complete({
      systemPrompt: 'write rationale',
      userPrompt: '{"name":"Test"}',
      responseFormat: 'text',
    });
    expect(out.text).toMatch(/##\s+Overview/);
    expect(out.text).toMatch(/##\s+Colors/);
    expect(out.text).toMatch(/##\s+Voice & Tone/);
  });

  it('honors a seeded brand name from the user prompt for stability', async () => {
    const llm = createFakeLlm();
    const out = await llm.complete({
      systemPrompt: 'extract',
      userPrompt: '<<NAME=Acme>>\nAcme is bold.',
      responseFormat: 'json',
    });
    expect(JSON.parse(out.text).name).toBe('Acme');
  });
});
```

- [ ] **Step 9: Run the test (must fail)**

Run: `npm --workspace apps/server test -- llm/fake`
Expected: FAIL with "Cannot find module './fake.js'"

- [ ] **Step 10: Implement fake.ts**

Create `apps/server/src/services/llm/fake.ts`:

```typescript
import type { LlmClient, LlmCompletion, LlmCompleteOptions } from './index.js';

const DEFAULT_TOKENS = {
  name: 'Untitled Brand',
  version: 1,
  description: 'Generated by fake LLM provider for development',
  colors: { primary: '#0091DA', accent: '#1B365D', surface: '#FFFFFF', on_surface: '#1A1C1E' },
  typography: {
    heading: { family: 'Inter', weights: [600, 700] },
    body: { family: 'Inter', weights: [400, 500] },
  },
  rounded: { sm: 4, md: 8, lg: 16 },
  spacing: { unit: 8, scale: [4, 8, 16, 24, 32, 48] },
  components: {},
  vpa: {
    voice: { tone: 'Confident, clear', avoid: ['jargon'] },
    audio: { music_mood: 'uplifting', sonic_logo: null },
    logo: { primary: null, mono: null, safe_zone_ratio: 0.25 },
    lower_thirds: { template: 'bar-left-accent', bg: '{colors.primary}', fg: '{colors.surface}' },
    taglines: [],
  },
};

const SAMPLE_BODY = `## Overview

The brand is built on confidence and clarity. Every visual choice serves a single goal: communicate substance without ornament.

## Colors

The primary color anchors the brand. Surface is the canvas. On-surface is the ink.

## Typography

Inter handles both display and reading roles. Heading weights carry hierarchy; body weights carry rhythm.

## Layout

The 8px grid is the unit of all spacing. Use the scale conservatively.

## Elevation & Depth

Elevation is communicated through subtle shadow and color shift, never lines.

## Shapes

Rounded corners are gentle. Sharp corners signal density.

## Components

Components inherit token values directly — never one-off color choices.

## Do's and Don'ts

- Do let whitespace breathe.
- Don't add decoration that doesn't carry meaning.

## Voice & Tone

Confident and clear. We say what we mean and stop.

- Do: "Build cloud-native, faster."
- Don't: "Embark on a transformative journey to unlock synergies."

## Audio

Music is uplifting and forward-leaning, never frantic.

## Logo Usage

Maintain the safe zone. Use the mono variant on busy backgrounds.
`;

export function createFakeLlm(): LlmClient {
  return {
    async complete(opts: LlmCompleteOptions): Promise<LlmCompletion> {
      if (opts.responseFormat === 'json') {
        const nameMatch = opts.userPrompt.match(/<<NAME=([^>]+)>>/);
        const name = nameMatch ? nameMatch[1].trim() : DEFAULT_TOKENS.name;
        const tokens = { ...DEFAULT_TOKENS, name };
        return { text: JSON.stringify(tokens, null, 2) };
      }
      return { text: SAMPLE_BODY };
    },
  };
}
```

- [ ] **Step 11: Run the tests (must pass)**

Run: `npm --workspace apps/server test -- llm/`
Expected: PASS — fake + prompts tests passing.

- [ ] **Step 12: Commit**

```bash
git add apps/server/src/services/llm/ \
        prompts/brand-extract-tokens.md \
        prompts/brand-write-rationale.md
git commit -m "feat(llm): client interface, fake provider, prompt loader, editable prompts"
```

---

## Task 10: Brand generation — extract-tokens (LLM call #1)

**Files:**
- Create: `apps/server/src/services/brand-generation/extract-tokens.ts`
- Create: `apps/server/src/services/brand-generation/extract-tokens.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/server/src/services/brand-generation/extract-tokens.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { extractTokens } from './extract-tokens.js';
import type { LlmClient } from '../llm/index.js';

const mkLlm = (responses: string[]): LlmClient => {
  let i = 0;
  return { complete: vi.fn(async () => ({ text: responses[i++] })) };
};

describe('extractTokens', () => {
  it('parses valid JSON returned by the LLM into DesignMdFrontMatter', async () => {
    const llm = mkLlm([JSON.stringify({
      name: 'Tanzu', version: 1,
      colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
      typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4, 8] },
      components: {},
    })]);
    const result = await extractTokens(llm, {
      systemPrompt: 'sys',
      sourceMarkdown: 'My brand is bold',
      brandName: 'Tanzu',
    });
    expect(result.frontMatter.name).toBe('Tanzu');
    expect(result.frontMatter.colors.primary).toBe('#0091DA');
  });

  it('strips code fences if the LLM wraps JSON in them', async () => {
    const llm = mkLlm(['```json\n' + JSON.stringify({
      name: 'X', version: 1,
      colors: { primary: '#000000', surface: '#FFFFFF', on_surface: '#000000' },
      typography: { heading: { family: 'I', weights: [400] }, body: { family: 'I', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4] },
      components: {},
    }) + '\n```']);
    const result = await extractTokens(llm, { systemPrompt: 's', sourceMarkdown: 'x', brandName: 'X' });
    expect(result.frontMatter.name).toBe('X');
  });

  it('retries once on invalid JSON, then succeeds', async () => {
    const llm = mkLlm(['not-json', JSON.stringify({
      name: 'Y', version: 1,
      colors: { primary: '#000000', surface: '#FFFFFF', on_surface: '#000000' },
      typography: { heading: { family: 'I', weights: [400] }, body: { family: 'I', weights: [400] } },
      rounded: { sm: 4, md: 8, lg: 16 },
      spacing: { unit: 8, scale: [4] },
      components: {},
    })]);
    const result = await extractTokens(llm, { systemPrompt: 's', sourceMarkdown: 'x', brandName: 'Y' });
    expect(result.frontMatter.name).toBe('Y');
    expect((llm.complete as any).mock.calls.length).toBe(2);
  });

  it('throws after a second invalid JSON, exposing raw text', async () => {
    const llm = mkLlm(['nope', 'still nope']);
    await expect(extractTokens(llm, { systemPrompt: 's', sourceMarkdown: 'x', brandName: 'Z' }))
      .rejects.toThrow(/raw response/);
  });

  it('throws when valid JSON fails the schema', async () => {
    const llm = mkLlm([JSON.stringify({ name: 'X' })]);  // missing required fields
    await expect(extractTokens(llm, { systemPrompt: 's', sourceMarkdown: 'x', brandName: 'X' }))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test (must fail)**

Run: `npm --workspace apps/server test -- extract-tokens`
Expected: FAIL.

- [ ] **Step 3: Implement extract-tokens.ts**

Create `apps/server/src/services/brand-generation/extract-tokens.ts`:

```typescript
import type { LlmClient } from '../llm/index.js';
import { DesignMdFrontMatter } from '@vpa/shared';

export interface ExtractTokensInput {
  systemPrompt: string;            // contents of prompts/brand-extract-tokens.md
  sourceMarkdown: string;          // concatenated extracted-text.md content
  brandName: string;
}

export interface ExtractTokensResult {
  frontMatter: DesignMdFrontMatter;
  rawResponse: string;
}

const STRICTER_HINT = '\n\nThe previous response was not valid JSON. Output ONLY a single JSON object — no prose, no code fences. Begin with `{` and end with `}`.';

export async function extractTokens(
  llm: LlmClient,
  input: ExtractTokensInput,
): Promise<ExtractTokensResult> {
  const userPrompt = `<<NAME=${input.brandName}>>\n\n${input.sourceMarkdown}`;

  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const sys = attempt === 0 ? input.systemPrompt : input.systemPrompt + STRICTER_HINT;
    const out = await llm.complete({
      systemPrompt: sys,
      userPrompt,
      responseFormat: 'json',
      temperature: 0.2,
    });
    lastRaw = out.text;
    const cleaned = stripFences(lastRaw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      continue; // retry
    }
    const validated = DesignMdFrontMatter.safeParse(parsed);
    if (!validated.success) {
      // Schema failure is non-retryable — surface immediately so user can hand-edit.
      throw new Error(
        `LLM returned valid JSON but it failed schema validation: ${validated.error.message}\nraw response: ${lastRaw}`,
      );
    }
    return { frontMatter: validated.data, rawResponse: lastRaw };
  }

  throw new Error(`LLM returned invalid JSON after 2 attempts. raw response: ${lastRaw}`);
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}
```

- [ ] **Step 4: Run the test (must pass)**

Run: `npm --workspace apps/server test -- extract-tokens`
Expected: PASS, 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/brand-generation/extract-tokens.ts \
        apps/server/src/services/brand-generation/extract-tokens.test.ts
git commit -m "feat(brand-gen): LLM token extraction with JSON retry and schema validation"
```

---

## Task 11: Brand generation — write-rationale (LLM call #2) and assemble

**Files:**
- Create: `apps/server/src/services/brand-generation/write-rationale.ts`
- Create: `apps/server/src/services/brand-generation/write-rationale.test.ts`
- Create: `apps/server/src/services/brand-generation/assemble.ts`
- Create: `apps/server/src/services/brand-generation/assemble.test.ts`

- [ ] **Step 1: Write failing test for write-rationale**

Create `apps/server/src/services/brand-generation/write-rationale.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { writeRationale } from './write-rationale.js';

describe('writeRationale', () => {
  const fm = {
    name: 'Tanzu', version: 1,
    colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
    typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
    rounded: { sm: 4, md: 8, lg: 16 },
    spacing: { unit: 8, scale: [4, 8] },
    components: {},
  };

  it('passes the front matter as JSON to the LLM and returns prose', async () => {
    const llm = { complete: vi.fn(async () => ({ text: '## Overview\n\nWritten by LLM' })) };
    const out = await writeRationale(llm, { systemPrompt: 'sys', frontMatter: fm });
    expect(out).toContain('## Overview');
    expect(llm.complete).toHaveBeenCalledOnce();
    const call = (llm.complete as any).mock.calls[0][0];
    expect(call.userPrompt).toContain('Tanzu');
    expect(call.responseFormat).toBe('text');
  });

  it('strips a leading front matter block if the LLM mistakenly includes one', async () => {
    const llm = { complete: vi.fn(async () => ({ text: '---\nname: Tanzu\n---\n\n## Overview\n\nbody' })) };
    const out = await writeRationale(llm, { systemPrompt: 'sys', frontMatter: fm });
    expect(out).not.toMatch(/^---/);
    expect(out).toContain('## Overview');
  });
});
```

- [ ] **Step 2: Run the test (must fail)**

Run: `npm --workspace apps/server test -- write-rationale`
Expected: FAIL.

- [ ] **Step 3: Implement write-rationale.ts**

Create `apps/server/src/services/brand-generation/write-rationale.ts`:

```typescript
import type { LlmClient } from '../llm/index.js';
import type { DesignMdFrontMatter } from '@vpa/shared';

export interface WriteRationaleInput {
  systemPrompt: string;
  frontMatter: DesignMdFrontMatter;
}

export async function writeRationale(
  llm: LlmClient,
  input: WriteRationaleInput,
): Promise<string> {
  const userPrompt = `Finalized design tokens (front matter):\n\n\`\`\`json\n${JSON.stringify(input.frontMatter, null, 2)}\n\`\`\`\n\nWrite the markdown body now.`;
  const out = await llm.complete({
    systemPrompt: input.systemPrompt,
    userPrompt,
    responseFormat: 'text',
    temperature: 0.6,
  });
  return stripLeadingFrontMatter(out.text).trim();
}

function stripLeadingFrontMatter(s: string): string {
  if (!s.trimStart().startsWith('---')) return s;
  const trimmed = s.trimStart();
  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) return s;
  return trimmed.slice(end + 4).replace(/^\n+/, '');
}
```

- [ ] **Step 4: Run the test (must pass)**

Run: `npm --workspace apps/server test -- write-rationale`
Expected: PASS.

- [ ] **Step 5: Write failing test for assemble**

Create `apps/server/src/services/brand-generation/assemble.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { assembleDesignMd } from './assemble.js';

describe('assembleDesignMd', () => {
  const fm = {
    name: 'Tanzu', version: 1,
    colors: { primary: '#0091DA', surface: '#FFFFFF', on_surface: '#1A1C1E' },
    typography: { heading: { family: 'Inter', weights: [600] }, body: { family: 'Inter', weights: [400] } },
    rounded: { sm: 4, md: 8, lg: 16 },
    spacing: { unit: 8, scale: [4, 8] },
    components: {},
  };

  it('produces design.md text that round-trips through gray-matter', async () => {
    const matter = (await import('gray-matter')).default;
    const text = assembleDesignMd(fm, '## Overview\n\nbody');
    expect(text.startsWith('---\n')).toBe(true);
    const parsed = matter(text);
    expect(parsed.data.name).toBe('Tanzu');
    expect(parsed.content.trim()).toMatch(/^## Overview/);
  });

  it('puts a single blank line between front matter and body', () => {
    const text = assembleDesignMd(fm, 'body');
    expect(text).toMatch(/---\n\nbody/);
  });
});
```

- [ ] **Step 6: Run the test (must fail)**

Run: `npm --workspace apps/server test -- assemble`
Expected: FAIL.

- [ ] **Step 7: Implement assemble.ts**

Create `apps/server/src/services/brand-generation/assemble.ts`:

```typescript
import yaml from 'js-yaml';
import type { DesignMdFrontMatter } from '@vpa/shared';

export function assembleDesignMd(frontMatter: DesignMdFrontMatter, body: string): string {
  const yamlText = yaml.dump(frontMatter, { lineWidth: 100, noRefs: true, sortKeys: false });
  return `---\n${yamlText}---\n\n${body.trim()}\n`;
}
```

- [ ] **Step 8: Run the test (must pass)**

Run: `npm --workspace apps/server test -- assemble`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/services/brand-generation/write-rationale.ts \
        apps/server/src/services/brand-generation/write-rationale.test.ts \
        apps/server/src/services/brand-generation/assemble.ts \
        apps/server/src/services/brand-generation/assemble.test.ts
git commit -m "feat(brand-gen): rationale writing (LLM call 2) and design.md assembly"
```

---

## Task 12: Brand generation pipeline — `brand.extract` job orchestrator

**Files:**
- Create: `apps/server/src/services/brand-generation/index.ts`
- Create: `apps/server/src/services/brand-generation/index.test.ts`

- [ ] **Step 1: Write failing test for the pipeline**

Create `apps/server/src/services/brand-generation/index.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandPaths } from '../brand/paths.js';
import { JobQueue } from '../../lib/job-queue.js';
import { runBrandExtractJob, runBrandGenerateJob } from './index.js';
import { createFakeLlm } from '../llm/fake.js';
import * as extractMod from '../document-extract/index.js';

vi.mock('../document-extract/index.js');

let tmp: string;
let paths: ReturnType<typeof brandPaths>;
let queue: JobQueue;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-pipeline-'));
  await mkdir(join(tmp, '.vpa'), { recursive: true });
  await mkdir(join(tmp, 'prompts'), { recursive: true });
  await writeFile(join(tmp, 'prompts', 'brand-extract-tokens.md'), 'extract sys');
  await writeFile(join(tmp, 'prompts', 'brand-write-rationale.md'), 'rationale sys');
  paths = brandPaths(tmp, join(tmp, '.vpa'));
  queue = new JobQueue();
  vi.resetAllMocks();
});

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('runBrandExtractJob', () => {
  it('persists sources, extracts text, runs LLM #1, emits tokens-ready', async () => {
    (extractMod.extract as any).mockResolvedValue({ markdown: '# Source\nbrand text', extractor: 'passthrough' });
    const job = queue.create('brand.extract');
    const events: any[] = [];
    queue.subscribe(job.id, (e) => events.push(e));

    await runBrandExtractJob({
      jobId: job.id,
      queue,
      paths,
      registryFile: paths.registryFile,
      workspaceRoot: tmp,
      llm: createFakeLlm(),
      slug: 'acme',
      brandName: 'Acme',
      sources: [{ kind: 'text', text: 'Acme is bold' }],
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('persisted');
    expect(types).toContain('tokens-ready');
    expect(queue.get(job.id)!.status).toBe('awaiting-input');

    const cached = await readFile(paths.extractedTextMd('acme'), 'utf8');
    expect(cached).toContain('brand text');
  });

  it('marks job failed when extraction throws', async () => {
    (extractMod.extract as any).mockRejectedValue(new Error('PDF corrupt'));
    const job = queue.create('brand.extract');
    await runBrandExtractJob({
      jobId: job.id,
      queue,
      paths,
      registryFile: paths.registryFile,
      workspaceRoot: tmp,
      llm: createFakeLlm(),
      slug: 'acme',
      brandName: 'Acme',
      sources: [{ kind: 'file', path: '/tmp/x.pdf' }],
    });
    expect(queue.get(job.id)!.status).toBe('failed');
    expect(queue.get(job.id)!.error).toMatch(/PDF corrupt/);
  });
});

describe('runBrandGenerateJob', () => {
  it('writes design.md with front matter + LLM-generated rationale', async () => {
    // Pre-populate as if extract job already ran.
    (extractMod.extract as any).mockResolvedValue({ markdown: '', extractor: 'passthrough' });
    const job1 = queue.create('brand.extract');
    await runBrandExtractJob({
      jobId: job1.id, queue, paths, registryFile: paths.registryFile, workspaceRoot: tmp,
      llm: createFakeLlm(), slug: 'acme', brandName: 'Acme',
      sources: [{ kind: 'text', text: 'x' }],
    });

    const tokens = (queue.get(job1.id)!.events.find((e) => e.type === 'tokens-ready')!.data as any).frontMatter;
    const job2 = queue.create('brand.generate');
    await runBrandGenerateJob({
      jobId: job2.id, queue, paths, registryFile: paths.registryFile, workspaceRoot: tmp,
      llm: createFakeLlm(),
      slug: 'acme', brandName: 'Acme', frontMatter: tokens,
    });
    expect(queue.get(job2.id)!.status).toBe('completed');
    const written = await readFile(paths.designMd('acme'), 'utf8');
    expect(written).toMatch(/---\nname: Acme/);
    expect(written).toMatch(/## Overview/);
  });
});
```

- [ ] **Step 2: Run the test (must fail)**

Run: `npm --workspace apps/server test -- brand-generation/index`
Expected: FAIL.

- [ ] **Step 3: Implement the pipeline orchestrator**

Create `apps/server/src/services/brand-generation/index.ts`:

```typescript
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { LlmClient } from '../llm/index.js';
import { loadPrompt } from '../llm/prompts.js';
import { extract } from '../document-extract/index.js';
import type { ExtractInput } from '../document-extract/index.js';
import { JobQueue } from '../../lib/job-queue.js';
import type { BrandPaths } from '../brand/paths.js';
import { createBrand, readBrand, updateBrandDoc } from '../brand/store.js';
import { extractTokens } from './extract-tokens.js';
import { writeRationale } from './write-rationale.js';
import type { DesignMdFrontMatter } from '@vpa/shared';

export interface BrandExtractJobInput {
  jobId: string;
  queue: JobQueue;
  paths: BrandPaths;
  registryFile: string;
  workspaceRoot: string;
  llm: LlmClient;
  slug: string;
  brandName: string;
  sources: ExtractInput[];
}

export async function runBrandExtractJob(input: BrandExtractJobInput): Promise<void> {
  const { jobId, queue, paths, workspaceRoot, llm, slug, brandName, sources } = input;
  try {
    queue.setStatus(jobId, 'running');

    // 1. Persist directory tree.
    await mkdir(paths.sourceDocsDir(slug), { recursive: true });

    // 2. Save sources metadata.
    const urls = sources.filter((s): s is Extract<ExtractInput, { kind: 'url' }> => s.kind === 'url').map((s) => s.url);
    const free = sources.filter((s): s is Extract<ExtractInput, { kind: 'text' }> => s.kind === 'text').map((s) => s.text);
    await writeFile(
      paths.sourcesJson(slug),
      JSON.stringify({ urls, free_text: free.join('\n\n---\n\n') }, null, 2) + '\n',
      'utf8',
    );
    queue.emit(jobId, 'persisted', { sources: sources.length });

    // 3. Extract each source to markdown.
    const chunks: string[] = [];
    for (const src of sources) {
      const label = src.kind === 'file' ? basename(src.path) : src.kind === 'url' ? src.url : '<free-text>';
      queue.emit(jobId, 'extracting', { source: label });
      const out = await extract(src);
      chunks.push(`<!-- source: ${label} (${out.extractor}) -->\n\n${out.markdown}`);
      queue.emit(jobId, 'extracted', { source: label, bytes: out.markdown.length });
    }
    const combined = chunks.join('\n\n---\n\n');
    await writeFile(paths.extractedTextMd(slug), combined, 'utf8');

    // 3a. Truncate to 200k chars before LLM call (cost + context window protection).
    const MAX_LLM_INPUT = 200_000;
    let llmInput = combined;
    if (combined.length > MAX_LLM_INPUT) {
      llmInput = combined.slice(0, MAX_LLM_INPUT);
      queue.emit(jobId, 'truncated', { original: combined.length, truncated: MAX_LLM_INPUT });
    }

    // 4. LLM call #1 — extract tokens.
    queue.emit(jobId, 'extracting-tokens');
    const sysPrompt = await loadPrompt(workspaceRoot, 'brand-extract-tokens');
    const tokens = await extractTokens(llm, {
      systemPrompt: sysPrompt,
      sourceMarkdown: llmInput,
      brandName,
    });

    // 5. Suspend awaiting user review.
    queue.setStatus(jobId, 'awaiting-input');
    queue.emit(jobId, 'tokens-ready', { frontMatter: tokens.frontMatter });
  } catch (err: any) {
    queue.fail(jobId, err.message ?? String(err));
  }
}

export interface BrandGenerateJobInput {
  jobId: string;
  queue: JobQueue;
  paths: BrandPaths;
  registryFile: string;
  workspaceRoot: string;
  llm: LlmClient;
  slug: string;
  brandName: string;
  frontMatter: DesignMdFrontMatter;
  isUpdate?: boolean; // true when called for re-generate / token-edit on existing brand
}

export async function runBrandGenerateJob(input: BrandGenerateJobInput): Promise<void> {
  const { jobId, queue, paths, registryFile, workspaceRoot, llm, slug, brandName, frontMatter, isUpdate } = input;
  try {
    queue.setStatus(jobId, 'running');

    // LLM call #2 — write rationale prose.
    queue.emit(jobId, 'writing-rationale');
    const sysPrompt = await loadPrompt(workspaceRoot, 'brand-write-rationale');
    const body = await writeRationale(llm, { systemPrompt: sysPrompt, frontMatter });

    // Persist.
    if (isUpdate) {
      await updateBrandDoc(paths, registryFile, slug, { frontMatter, body });
    } else {
      await createBrand(paths, registryFile, { slug, name: brandName, frontMatter, body });
    }
    const persisted = await readBrand(paths, registryFile, slug);

    queue.complete(jobId, { brand_slug: slug, version: persisted.registry.version });
  } catch (err: any) {
    queue.fail(jobId, err.message ?? String(err));
  }
}
```

- [ ] **Step 4: Run the test (must pass)**

Run: `npm --workspace apps/server test -- brand-generation/index`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/brand-generation/index.ts \
        apps/server/src/services/brand-generation/index.test.ts
git commit -m "feat(brand-gen): brand.extract and brand.generate job orchestrators"
```

---

## Task 13: Brand routes — list, create, generate (resume), detail, download

**Files:**
- Modify: `apps/server/package.json` (add `@fastify/multipart`)
- Create: `apps/server/src/routes/brands.ts`
- Create: `apps/server/src/routes/brands.test.ts`
- Modify: `apps/server/src/server.ts` (register multipart, register brand routes)

- [ ] **Step 1: Add @fastify/multipart**

```bash
npm --workspace apps/server install @fastify/multipart@8
```

- [ ] **Step 2: Register multipart in server bootstrap**

Modify `apps/server/src/server.ts`. Inside `buildServer()`, before route registrations, add:

```typescript
import multipart from '@fastify/multipart';
// ...
await app.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB per file (PDF cap from spec)
    files: 10,
  },
});
```

- [ ] **Step 3: Write failing integration tests for the routes**

Create `apps/server/src/routes/brands.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBrandRoutes } from './brands.js';
import { registerJobRoutes } from './jobs.js';
import { jobQueue } from '../lib/job-queue.js';
import { brandPaths } from '../services/brand/paths.js';

let app: FastifyInstance;
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vpa-routes-'));
  await mkdir(join(tmp, '.vpa'), { recursive: true });
  await mkdir(join(tmp, 'prompts'), { recursive: true });
  await writeFile(join(tmp, 'prompts', 'brand-extract-tokens.md'), 'sys');
  await writeFile(join(tmp, 'prompts', 'brand-write-rationale.md'), 'sys');

  app = Fastify();
  await app.register(multipart, { limits: { fileSize: 50_000_000, files: 10 } });
  await registerBrandRoutes(app, {
    paths: brandPaths(tmp, join(tmp, '.vpa')),
    registryFile: join(tmp, '.vpa', 'brands.json'),
    workspaceRoot: tmp,
  });
  await registerJobRoutes(app);
});

afterEach(async () => {
  await app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('GET /api/brands', () => {
  it('returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/brands' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ default_brand_id: null, brands: [] });
  });
});

describe('POST /api/brands', () => {
  it('creates a brand with free-text source and returns job_id + slug', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { name: 'Acme', free_text: 'Acme is bold and clean' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.slug).toBe('acme');
    expect(body.job_id).toMatch(/^[0-9a-f-]{36}$/);

    // Wait for the extract job to reach awaiting-input.
    await waitForStatus(body.job_id, 'awaiting-input');
    const job = jobQueue.get(body.job_id)!;
    expect(job.events.some((e) => e.type === 'tokens-ready')).toBe(true);
  });

  it('rejects when name is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { free_text: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects when no source provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/brands/:slug/generate (resume)', () => {
  it('resumes the extract job by writing the design.md', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { name: 'Acme', free_text: 'Acme is bold' },
    });
    const { job_id, slug } = create.json();
    await waitForStatus(job_id, 'awaiting-input');
    const tokens = (jobQueue.get(job_id)!.events.find((e) => e.type === 'tokens-ready')!.data as any).frontMatter;

    const generate = await app.inject({
      method: 'POST',
      url: `/api/brands/${slug}/generate`,
      payload: { front_matter: tokens },
    });
    expect(generate.statusCode).toBe(202);
    const { job_id: gjob } = generate.json();
    await waitForStatus(gjob, 'completed');

    const detail = await app.inject({ method: 'GET', url: `/api/brands/${slug}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().registry.id).toBe('acme');
  });
});

describe('GET /api/brands/:slug/download', () => {
  it('streams the design.md file with content-disposition', async () => {
    // Create + generate first (use the helper above pattern).
    const create = await app.inject({
      method: 'POST', url: '/api/brands',
      payload: { name: 'Acme', free_text: 'Acme is bold' },
    });
    const { job_id, slug } = create.json();
    await waitForStatus(job_id, 'awaiting-input');
    const tokens = (jobQueue.get(job_id)!.events.find((e) => e.type === 'tokens-ready')!.data as any).frontMatter;
    const generate = await app.inject({
      method: 'POST', url: `/api/brands/${slug}/generate`,
      payload: { front_matter: tokens },
    });
    await waitForStatus(generate.json().job_id, 'completed');

    const dl = await app.inject({ method: 'GET', url: `/api/brands/${slug}/download` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain('acme-design.md');
    expect(dl.body).toMatch(/^---\n/);
  });
});

async function waitForStatus(jobId: string, target: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const j = jobQueue.get(jobId);
    if (j?.status === target) return;
    if (j?.status === 'failed') throw new Error(`Job failed: ${j.error}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for status ${target}`);
}
```

- [ ] **Step 4: Run the test (must fail)**

Run: `npm --workspace apps/server test -- routes/brands`
Expected: FAIL with "Cannot find module './brands.js'"

- [ ] **Step 5: Implement brand routes (list / create / generate / detail / download)**

Create `apps/server/src/routes/brands.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { z } from 'zod';
import type { BrandPaths } from '../services/brand/paths.js';
import { jobQueue } from '../lib/job-queue.js';
import { listBrands, readBrand } from '../services/brand/store.js';
import { runBrandExtractJob, runBrandGenerateJob } from '../services/brand-generation/index.js';
import type { ExtractInput } from '../services/document-extract/index.js';
import { createFakeLlm } from '../services/llm/fake.js';
import { DesignMdFrontMatter } from '@vpa/shared';
import { setDefault } from '../services/brand/registry.js';

export interface BrandRouteOptions {
  paths: BrandPaths;
  registryFile: string;
  workspaceRoot: string;
}

const SUPPORTED_EXTS = ['.pdf', '.md', '.markdown', '.txt'];

export async function registerBrandRoutes(app: FastifyInstance, opts: BrandRouteOptions): Promise<void> {
  const { paths, registryFile, workspaceRoot } = opts;
  const llm = createFakeLlm(); // TODO: swap for real provider in follow-on plan

  // GET /api/brands
  app.get('/api/brands', async () => listBrands(registryFile));

  // POST /api/brands — multipart or JSON
  app.post('/api/brands', async (req, reply) => {
    const sources: ExtractInput[] = [];
    let name: string | undefined;

    if (req.isMultipart()) {
      const parts = req.parts();
      const tmpUploadDir = join(workspaceRoot, '.vpa', 'uploads', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(tmpUploadDir, { recursive: true });
      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'name')      name = String(part.value);
          if (part.fieldname === 'free_text' && part.value) sources.push({ kind: 'text', text: String(part.value) });
          if (part.fieldname === 'url'      && part.value) sources.push({ kind: 'url',  url:  String(part.value) });
        } else if (part.type === 'file') {
          const ext = part.filename ? part.filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] : '';
          if (!ext || !SUPPORTED_EXTS.includes(ext)) {
            return reply.code(400).send({ error: `Unsupported file extension: ${part.filename}` });
          }
          const dest = join(tmpUploadDir, basename(part.filename));
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(chunk as Buffer);
          await writeFile(dest, Buffer.concat(chunks));
          sources.push({ kind: 'file', path: dest });
        }
      }
    } else {
      const body = (req.body ?? {}) as Record<string, unknown>;
      name = typeof body.name === 'string' ? body.name : undefined;
      if (typeof body.free_text === 'string' && body.free_text.length > 0) sources.push({ kind: 'text', text: body.free_text });
      if (typeof body.url === 'string'       && body.url.length > 0)       sources.push({ kind: 'url',  url:  body.url });
    }

    if (!name) return reply.code(400).send({ error: 'name is required' });
    if (sources.length === 0) return reply.code(400).send({ error: 'at least one source is required' });

    const slug = slugify(name);
    const reg = await listBrands(registryFile);
    if (reg.brands.some((b) => b.id === slug)) {
      return reply.code(409).send({ error: `Brand "${slug}" already exists` });
    }

    const job = jobQueue.create('brand.extract');
    runBrandExtractJob({
      jobId: job.id,
      queue: jobQueue,
      paths, registryFile, workspaceRoot,
      llm,
      slug,
      brandName: name,
      sources,
    }).catch(() => { /* errors recorded on the job */ });

    return reply.code(202).send({ job_id: job.id, slug });
  });

  // POST /api/brands/:slug/generate
  app.post<{ Params: { slug: string }, Body: { front_matter: unknown } }>(
    '/api/brands/:slug/generate',
    async (req, reply) => {
      const parsed = DesignMdFrontMatter.safeParse(req.body?.front_matter);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid front_matter', details: parsed.error.issues });

      const job = jobQueue.create('brand.generate');
      runBrandGenerateJob({
        jobId: job.id,
        queue: jobQueue,
        paths, registryFile, workspaceRoot,
        llm,
        slug: req.params.slug,
        brandName: parsed.data.name,
        frontMatter: parsed.data,
        isUpdate: false,
      }).catch(() => { /* errors recorded on the job */ });

      return reply.code(202).send({ job_id: job.id });
    },
  );

  // GET /api/brands/:slug
  app.get<{ Params: { slug: string } }>('/api/brands/:slug', async (req, reply) => {
    try {
      return await readBrand(paths, registryFile, req.params.slug);
    } catch (err: any) {
      return reply.code(404).send({ error: err.message ?? 'Not found' });
    }
  });

  // GET /api/brands/:slug/download
  app.get<{ Params: { slug: string } }>('/api/brands/:slug/download', async (req, reply) => {
    const path = paths.designMd(req.params.slug);
    try { await stat(path); } catch { return reply.code(404).send({ error: 'Brand not found' }); }
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${req.params.slug}-design.md"`);
    return reply.send(createReadStream(path));
  });

  // DELETE /api/brands/:slug — gated by referencing-projects unless force=true (project guard implemented in Task 14)
  app.delete<{ Params: { slug: string }, Querystring: { force?: string } }>(
    '/api/brands/:slug',
    async (req, reply) => {
      const force = req.query.force === 'true';
      // Project-reference check is added in Task 14.
      const { deleteBrand } = await import('../services/brand/store.js');
      await deleteBrand(paths, registryFile, req.params.slug);
      void force;
      return reply.code(204).send();
    },
  );
}

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
```

- [ ] **Step 6: Wire routes into server bootstrap**

Modify `apps/server/src/server.ts`. Inside `buildServer()`, after job routes registration, add:

```typescript
import { registerBrandRoutes } from './routes/brands.js';
import { brandPaths } from './services/brand/paths.js';
// ...
const paths = brandPaths(config.workspaceRoot, config.vpaDir);
await registerBrandRoutes(app, {
  paths,
  registryFile: paths.registryFile,
  workspaceRoot: config.workspaceRoot,
});
```

(Plan 01 should already define `config.workspaceRoot` and `config.vpaDir`. If not, expose them in the existing `config.ts` per Plan 01 Task 3.)

- [ ] **Step 7: Run the test (must pass)**

Run: `npm --workspace apps/server test -- routes/brands`
Expected: PASS, all route tests passing.

- [ ] **Step 8: Commit**

```bash
git add apps/server/package.json apps/server/package-lock.json \
        apps/server/src/server.ts \
        apps/server/src/routes/brands.ts \
        apps/server/src/routes/brands.test.ts
git commit -m "feat(brand routes): create/list/generate/detail/download with multipart and SSE jobs"
```

---

## Task 14: Brand routes — fork, regenerate, update, assets, project-aware delete

**Files:**
- Modify: `apps/server/src/routes/brands.ts`
- Modify: `apps/server/src/routes/brands.test.ts`

- [ ] **Step 1: Extend the existing test file with cases for the new routes**

Append to `apps/server/src/routes/brands.test.ts`:

```typescript
describe('POST /api/brands/:slug/fork', () => {
  it('creates a fork with the parent reference', async () => {
    const created = await createAndGenerate(app, 'Acme', 'Acme is bold');
    const fork = await app.inject({
      method: 'POST',
      url: `/api/brands/${created.slug}/fork`,
      payload: { name: 'Acme · Q4 Launch' },
    });
    expect(fork.statusCode).toBe(201);
    const body = fork.json();
    expect(body.registry.forked_from).toBe(created.slug);
    expect(body.registry.id).toBe(`${created.slug}--q4-launch`);
  });
});

describe('PUT /api/brands/:slug — set default', () => {
  it('sets and unsets the default brand', async () => {
    const a = await createAndGenerate(app, 'Acme', 'Acme is bold');
    await createAndGenerate(app, 'Beta', 'Beta is calm');

    const set = await app.inject({
      method: 'PUT',
      url: `/api/brands/${a.slug}`,
      payload: { is_default: true },
    });
    expect(set.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/brands' });
    expect(list.json().default_brand_id).toBe(a.slug);

    const unset = await app.inject({
      method: 'PUT',
      url: `/api/brands/${a.slug}`,
      payload: { is_default: false },
    });
    expect(unset.statusCode).toBe(200);
    const list2 = await app.inject({ method: 'GET', url: '/api/brands' });
    expect(list2.json().default_brand_id).toBeNull();
  });
});

describe('POST /api/brands/:slug/regenerate', () => {
  it('runs the generate pipeline against cached extracted-text and bumps version', async () => {
    const created = await createAndGenerate(app, 'Acme', 'Acme is bold');
    const before = (await app.inject({ method: 'GET', url: `/api/brands/${created.slug}` })).json();

    const regen = await app.inject({ method: 'POST', url: `/api/brands/${created.slug}/regenerate` });
    expect(regen.statusCode).toBe(202);
    const { job_id } = regen.json();
    await waitForStatus(job_id, 'completed');

    const after = (await app.inject({ method: 'GET', url: `/api/brands/${created.slug}` })).json();
    expect(after.registry.version).toBe(before.registry.version + 1);
  });
});

describe('POST /api/brands/:slug/assets', () => {
  it('accepts a logo upload and updates vpa.logo.primary', async () => {
    const created = await createAndGenerate(app, 'Acme', 'Acme is bold');
    const form = new FormData();
    form.append('field', 'primary');
    form.append('file', new Blob([Buffer.from('<svg/>')], { type: 'image/svg+xml' }), 'logo.svg');

    const upload = await app.inject({
      method: 'POST',
      url: `/api/brands/${created.slug}/assets`,
      payload: form,
    });
    expect(upload.statusCode).toBe(201);

    const detail = (await app.inject({ method: 'GET', url: `/api/brands/${created.slug}` })).json();
    expect(detail.doc.frontMatter.vpa.logo.primary).toBe('assets/logo.svg');
  });
});

describe('DELETE /api/brands/:slug — project guard', () => {
  it('returns 409 when a project references the brand', async () => {
    const created = await createAndGenerate(app, 'Acme', 'Acme is bold');
    // Simulate a project pointing at this brand by writing a stub project file.
    // The route reads the project store; in this test we'll inject a fake project list
    // by writing to the test-only project tracker location.
    // (Implementation note: the real check goes through the project store API.)
    await mockProjectReference(created.slug);

    const del = await app.inject({ method: 'DELETE', url: `/api/brands/${created.slug}` });
    expect(del.statusCode).toBe(409);
    expect(del.json().referencing_projects.length).toBeGreaterThan(0);

    const force = await app.inject({ method: 'DELETE', url: `/api/brands/${created.slug}?force=true` });
    expect(force.statusCode).toBe(204);
  });
});

// --- helpers added at bottom of file ---

async function createAndGenerate(
  app: FastifyInstance,
  name: string,
  free_text: string,
): Promise<{ slug: string }> {
  const create = await app.inject({ method: 'POST', url: '/api/brands', payload: { name, free_text } });
  const { job_id, slug } = create.json();
  await waitForStatus(job_id, 'awaiting-input');
  const tokens = (jobQueue.get(job_id)!.events.find((e) => e.type === 'tokens-ready')!.data as any).frontMatter;
  const gen = await app.inject({ method: 'POST', url: `/api/brands/${slug}/generate`, payload: { front_matter: tokens } });
  await waitForStatus(gen.json().job_id, 'completed');
  return { slug };
}

async function mockProjectReference(slug: string): Promise<void> {
  // Write a project entry in the test workspace's projects.json (Plan 01 location).
  // Test-only seam — adjust path if Plan 01 places it elsewhere.
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  // Use the same workspace tmpdir (resolved from `tmp` in beforeEach).
  const trackerDir = path.join(os.homedir(), '.vpa');
  const trackerFile = path.join(trackerDir, 'projects.json');
  await fs.mkdir(trackerDir, { recursive: true });
  await fs.writeFile(trackerFile, JSON.stringify({
    projects: [{
      id: 'proj-1', name: 'Test Project', root: '/tmp/proj-1',
      created: '2026-04-30T00:00:00Z', last_seen: '2026-04-30T00:00:00Z',
      brand: { id: slug, applied_version: 1 },
    }],
  }), 'utf8');
}
```

- [ ] **Step 2: Run the test (must fail)**

Run: `npm --workspace apps/server test -- routes/brands`
Expected: FAIL — fork, PUT, regenerate, assets, project-guard tests fail.

- [ ] **Step 3: Extend brand routes with the new endpoints**

Modify `apps/server/src/routes/brands.ts` — add inside `registerBrandRoutes`, before the `delete` handler:

```typescript
import { forkBrand } from '../services/brand/fork.js';
import { readFile, writeFile, copyFile, unlink } from 'node:fs/promises';

// POST /api/brands/:slug/fork
app.post<{ Params: { slug: string }, Body: { name: string } }>(
  '/api/brands/:slug/fork',
  async (req, reply) => {
    if (typeof req.body?.name !== 'string' || req.body.name.trim() === '') {
      return reply.code(400).send({ error: 'name is required' });
    }
    try {
      const fork = await forkBrand(paths, registryFile, req.params.slug, { name: req.body.name });
      return reply.code(201).send(fork);
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  },
);

// PUT /api/brands/:slug
app.put<{ Params: { slug: string }, Body: { is_default?: boolean; front_matter?: unknown; body?: string } }>(
  '/api/brands/:slug',
  async (req, reply) => {
    const { slug } = req.params;
    if (typeof req.body?.is_default === 'boolean') {
      await setDefault(registryFile, req.body.is_default ? slug : null);
      return readBrand(paths, registryFile, slug);
    }
    if (req.body?.front_matter !== undefined && typeof req.body?.body === 'string') {
      const parsed = DesignMdFrontMatter.safeParse(req.body.front_matter);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid front_matter', details: parsed.error.issues });
      const { updateBrandDoc } = await import('../services/brand/store.js');
      return updateBrandDoc(paths, registryFile, slug, { frontMatter: parsed.data, body: req.body.body });
    }
    return reply.code(400).send({ error: 'Body must include either is_default or {front_matter, body}' });
  },
);

// POST /api/brands/:slug/regenerate
app.post<{ Params: { slug: string } }>(
  '/api/brands/:slug/regenerate',
  async (req, reply) => {
    const { slug } = req.params;
    const current = await readBrand(paths, registryFile, slug);
    const cached = await readFile(paths.extractedTextMd(slug), 'utf8').catch(() => '');
    if (!cached) return reply.code(409).send({ error: 'No cached extraction available; resubmit sources' });

    // Re-run extract-tokens then write-rationale; bump version.
    const job = jobQueue.create('brand.regenerate');
    (async () => {
      try {
        jobQueue.setStatus(job.id, 'running');
        const sysExtract = await (await import('../services/llm/prompts.js')).loadPrompt(workspaceRoot, 'brand-extract-tokens');
        const { extractTokens } = await import('../services/brand-generation/extract-tokens.js');
        const tokens = await extractTokens(llm, { systemPrompt: sysExtract, sourceMarkdown: cached, brandName: current.registry.name });

        const nextFm = { ...tokens.frontMatter, version: current.registry.version + 1, name: current.registry.name };
        await runBrandGenerateJob({
          jobId: job.id, queue: jobQueue, paths, registryFile, workspaceRoot,
          llm, slug, brandName: current.registry.name, frontMatter: nextFm,
          isUpdate: true,
        });
      } catch (err: any) {
        jobQueue.fail(job.id, err.message ?? String(err));
      }
    })();
    return reply.code(202).send({ job_id: job.id });
  },
);

// POST /api/brands/:slug/assets
app.post<{ Params: { slug: string } }>(
  '/api/brands/:slug/assets',
  async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'multipart required' });
    let field: 'primary' | 'mono' | 'other' = 'other';
    let savedRel: string | null = null;
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'field') {
        const v = String(part.value);
        if (v === 'primary' || v === 'mono') field = v;
      } else if (part.type === 'file') {
        const dest = join(paths.assetsDir(req.params.slug), basename(part.filename));
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        await writeFile(dest, Buffer.concat(chunks));
        savedRel = `assets/${basename(part.filename)}`;
      }
    }
    if (!savedRel) return reply.code(400).send({ error: 'No file uploaded' });

    if (field === 'primary' || field === 'mono') {
      const brand = await readBrand(paths, registryFile, req.params.slug);
      const fm = brand.doc.frontMatter;
      const previousPath = fm.vpa?.logo[field] ?? null;
      // Per spec §3.4: only bump version when the recorded path actually changes.
      // Replacing a file at the same path is an asset-only change and does not mutate design.md.
      if (previousPath !== savedRel) {
        const nextVpa = {
          ...(fm.vpa ?? {
            voice: { tone: '', avoid: [] },
            audio: { music_mood: null, sonic_logo: null },
            logo:  { primary: null, mono: null, safe_zone_ratio: 0.25 },
            lower_thirds: { template: 'bar-left-accent' as const, bg: '{colors.primary}', fg: '{colors.surface}' },
            taglines: [],
          }),
          logo: { ...(fm.vpa?.logo ?? { primary: null, mono: null, safe_zone_ratio: 0.25 }), [field]: savedRel },
        };
        const nextFm = { ...fm, version: brand.registry.version + 1, vpa: nextVpa };
        const { updateBrandDoc } = await import('../services/brand/store.js');
        await updateBrandDoc(paths, registryFile, req.params.slug, { frontMatter: nextFm, body: brand.doc.body });
      }
    }
    return reply.code(201).send({ path: savedRel, version_bumped: field !== 'other' && (await readBrand(paths, registryFile, req.params.slug)).registry.version });
  },
);

// DELETE /api/brands/:slug/assets/:file
app.delete<{ Params: { slug: string, file: string } }>(
  '/api/brands/:slug/assets/:file',
  async (req, reply) => {
    const target = join(paths.assetsDir(req.params.slug), basename(req.params.file));
    await unlink(target).catch(() => undefined);
    return reply.code(204).send();
  },
);
```

- [ ] **Step 4: Replace the simple DELETE with project-guard logic**

Modify the DELETE handler (replace its body):

```typescript
app.delete<{ Params: { slug: string }, Querystring: { force?: string } }>(
  '/api/brands/:slug',
  async (req, reply) => {
    const force = req.query.force === 'true';
    const projects = await listReferencingProjects(req.params.slug);
    if (projects.length > 0 && !force) {
      return reply.code(409).send({
        error: 'Brand is referenced by projects',
        referencing_projects: projects,
      });
    }
    const { deleteBrand } = await import('../services/brand/store.js');
    await deleteBrand(paths, registryFile, req.params.slug);
    return reply.code(204).send();
  },
);
```

And add this helper at the bottom of the file:

```typescript
// Reads the Plan-01 project tracker and returns the list of projects whose brand.id == slug.
async function listReferencingProjects(slug: string): Promise<Array<{ id: string; name: string }>> {
  // Plan 01 places the tracker at ~/.vpa/projects.json. Import its read helper if exposed,
  // otherwise read it directly here.
  try {
    const { homedir } = await import('node:os');
    const { readFile } = await import('node:fs/promises');
    const path = `${homedir()}/.vpa/projects.json`;
    const raw = await readFile(path, 'utf8');
    const data = JSON.parse(raw) as { projects: Array<{ id: string; name: string; brand?: { id: string } | null }> };
    return data.projects
      .filter((p) => p.brand?.id === slug)
      .map((p) => ({ id: p.id, name: p.name }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run the tests (must pass)**

Run: `npm --workspace apps/server test -- routes/brands`
Expected: PASS — all 9+ route tests passing.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/brands.ts apps/server/src/routes/brands.test.ts
git commit -m "feat(brand routes): fork, default toggle, regenerate, assets, project-aware delete"
```

---

## Task 15: Web API client extension + Dashboard Brands section

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/components/BrandCard.tsx`
- Create: `apps/web/src/components/BrandCard.test.tsx` (optional — only if Plan 01 set up RTL; otherwise visual-only)
- Modify: `apps/web/src/pages/Dashboard.tsx`
- Modify: `apps/web/src/App.tsx` (route imports for upcoming pages)

- [ ] **Step 1: Extend the typed API client**

Modify `apps/web/src/lib/api.ts`. Add the following exports (assume the file already exports a `request` helper and `apiBase` from Plan 01):

```typescript
import type { BrandRegistry, BrandRegistryEntry, BrandWithDoc, DesignMdFrontMatter, Job } from '@vpa/shared';

export const brandsApi = {
  async list(): Promise<BrandRegistry> {
    return request<BrandRegistry>('/api/brands');
  },

  async detail(slug: string): Promise<BrandWithDoc> {
    return request<BrandWithDoc>(`/api/brands/${slug}`);
  },

  async create(form: FormData): Promise<{ job_id: string; slug: string }> {
    const res = await fetch(`${apiBase}/api/brands`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Create failed: ${res.status}`);
    return res.json();
  },

  async generate(slug: string, frontMatter: DesignMdFrontMatter): Promise<{ job_id: string }> {
    return request(`/api/brands/${slug}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ front_matter: frontMatter }),
    });
  },

  async setDefault(slug: string, isDefault: boolean): Promise<BrandRegistryEntry> {
    return request(`/api/brands/${slug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_default: isDefault }),
    });
  },

  async fork(slug: string, name: string): Promise<BrandWithDoc> {
    return request(`/api/brands/${slug}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  },

  async regenerate(slug: string): Promise<{ job_id: string }> {
    return request(`/api/brands/${slug}/regenerate`, { method: 'POST' });
  },

  async uploadAsset(slug: string, file: File, field: 'primary' | 'mono' | 'other' = 'other'): Promise<{ path: string }> {
    const form = new FormData();
    form.append('field', field);
    form.append('file', file);
    const res = await fetch(`${apiBase}/api/brands/${slug}/assets`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json();
  },

  async delete(slug: string, force = false): Promise<void> {
    const res = await fetch(`${apiBase}/api/brands/${slug}${force ? '?force=true' : ''}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      if (res.status === 409) {
        const body = await res.json();
        throw Object.assign(new Error('Brand is in use'), { code: 'in-use', referencing_projects: body.referencing_projects });
      }
      throw new Error(`Delete failed: ${res.status}`);
    }
  },

  download(slug: string): string {
    return `${apiBase}/api/brands/${slug}/download`;
  },
};

export const jobsApi = {
  async get(id: string): Promise<Job> {
    return request<Job>(`/api/jobs/${id}`);
  },
  stream(id: string, onEvent: (event: { type: string; data?: unknown }) => void): () => void {
    const es = new EventSource(`${apiBase}/api/jobs/${id}/stream`);
    es.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    // Listen for named events too (server uses event: <name>).
    const knownEvents = [
      'persisted', 'extracting', 'extracted', 'extracting-tokens',
      'tokens-ready', 'writing-rationale', 'done', 'error',
    ];
    for (const evt of knownEvents) {
      es.addEventListener(evt, (e: MessageEvent) => {
        try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ }
      });
    }
    return () => es.close();
  },
};
```

- [ ] **Step 2: Create the BrandCard component**

Create `apps/web/src/components/BrandCard.tsx`:

```typescript
import { Link } from 'react-router-dom';
import type { BrandRegistryEntry } from '@vpa/shared';

interface Props {
  entry: BrandRegistryEntry;
  swatch?: string;          // hex color from doc.frontMatter.colors.primary if loaded
  isDefault: boolean;
}

export function BrandCard({ entry, swatch, isDefault }: Props) {
  const isFork = entry.forked_from !== null;
  return (
    <Link to={`/brands/${entry.id}`} className="brand-card">
      <span
        className="brand-card__swatch"
        style={{ background: swatch ?? '#334155' }}
        aria-label={swatch ? `primary color ${swatch}` : 'no color loaded'}
      />
      <span className="brand-card__name">{entry.name}</span>
      {isDefault && <span className="brand-card__badge brand-card__badge--default" title="Default brand">⭐</span>}
      {isFork && <span className="brand-card__badge brand-card__badge--fork" title={`fork of ${entry.forked_from}`}>🔗</span>}
    </Link>
  );
}
```

Add minimal CSS to `apps/web/src/styles.css`:

```css
.brand-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border, #1e293b);
  border-radius: 6px;
  text-decoration: none;
  color: inherit;
  background: #0f172a;
}
.brand-card:hover { border-color: #334155; }
.brand-card__swatch {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  flex-shrink: 0;
}
.brand-card__name { font-weight: 500; flex: 1; }
.brand-card__badge { opacity: 0.85; font-size: 14px; }
```

- [ ] **Step 3: Add Brands section to Dashboard**

Modify `apps/web/src/pages/Dashboard.tsx`. Below the existing ProjectList block, add:

```typescript
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { brandsApi } from '../lib/api';
import { BrandCard } from '../components/BrandCard';

// Inside the Dashboard component's render output, after <ProjectList />:

function BrandsSection() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['brands'],
    queryFn: () => brandsApi.list(),
  });

  if (isLoading) return <section className="section"><h2>Brands</h2><p>Loading...</p></section>;
  if (error)     return <section className="section"><h2>Brands</h2><p>Failed to load brands.</p></section>;

  const list = data!.brands;
  return (
    <section className="section">
      <header className="section__header">
        <h2>Brands</h2>
        <Link to="/brands/new" className="button button--primary">+ New Brand</Link>
      </header>
      {list.length === 0 ? (
        <p className="empty">No brands yet. Create your first brand to apply consistent visual identity across video projects.</p>
      ) : (
        <ul className="brand-grid">
          {list.map((entry) => (
            <li key={entry.id}>
              <BrandCard entry={entry} isDefault={entry.id === data!.default_brand_id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Then in the Dashboard JSX:
// <BrandsSection />
```

Add CSS:

```css
.section__header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.brand-grid { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.empty { color: #94a3b8; }
.button { padding: 6px 12px; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; text-decoration: none; cursor: pointer; }
.button--primary { background: #6366f1; border-color: #6366f1; }
```

- [ ] **Step 4: Add brand routes to the router**

Modify `apps/web/src/App.tsx`. Add the imports and routes (the page components will be implemented in Tasks 17–19; for now create stub files so the routes resolve):

Create stub `apps/web/src/pages/BrandNew.tsx`:

```typescript
export default function BrandNew() {
  return <main><h1>New Brand</h1><p>Wizard coming in Task 17.</p></main>;
}
```

Create stub `apps/web/src/pages/BrandDetail.tsx`:

```typescript
export default function BrandDetail() {
  return <main><h1>Brand Detail</h1><p>Detail view coming in Task 19.</p></main>;
}
```

In `App.tsx`:

```typescript
import BrandNew from './pages/BrandNew';
import BrandDetail from './pages/BrandDetail';

// Inside the <Routes> block, add:
<Route path="/brands/new"      element={<BrandNew />} />
<Route path="/brands/:slug"    element={<BrandDetail />} />
```

- [ ] **Step 5: Smoke test in dev**

Run: `npm run dev` (or whatever Plan 01 named the concurrent dev script). Open `http://localhost:5173`.

Expected: Dashboard loads, Brands section shows empty state with "+ New Brand" button. Clicking it navigates to `/brands/new` (stub page).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/api.ts \
        apps/web/src/components/BrandCard.tsx \
        apps/web/src/pages/Dashboard.tsx apps/web/src/pages/BrandNew.tsx apps/web/src/pages/BrandDetail.tsx \
        apps/web/src/App.tsx apps/web/src/styles.css
git commit -m "feat(web): brand API client, BrandCard, Dashboard Brands section, routes"
```

---

## Task 16: BrandPicker component + project integration

**Files:**
- Create: `apps/web/src/components/BrandPicker.tsx`
- Modify: `apps/web/src/components/NewProjectDialog.tsx` (from Plan 01) — embed BrandPicker
- Modify: relevant project edit/detail page to embed BrandPicker (if Plan 01 created one)

- [ ] **Step 1: Implement BrandPicker**

Create `apps/web/src/components/BrandPicker.tsx`:

```typescript
import { useQuery } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { brandsApi } from '../lib/api';
import type { BrandRegistry } from '@vpa/shared';

interface Props {
  value: { id: string; applied_version: number } | null;
  onChange: (next: { id: string; applied_version: number } | null) => void;
}

export function BrandPicker({ value, onChange }: Props) {
  const { data } = useQuery({ queryKey: ['brands'], queryFn: () => brandsApi.list() });
  const [query, setQuery] = useState('');

  const filtered = useMemo<BrandRegistry['brands']>(() => {
    if (!data) return [];
    if (!query.trim()) return data.brands;
    const q = query.toLowerCase();
    return data.brands.filter((b) => b.name.toLowerCase().includes(q) || b.id.includes(q));
  }, [data, query]);

  const selectedEntry = data?.brands.find((b) => b.id === value?.id) ?? null;

  return (
    <div className="brand-picker">
      <label className="label">Brand</label>
      {selectedEntry ? (
        <div className="brand-picker__current">
          <span className="brand-picker__name">{selectedEntry.name}</span>
          {selectedEntry.id === data?.default_brand_id && <span title="Default">⭐</span>}
          {selectedEntry.forked_from && <span title={`fork of ${selectedEntry.forked_from}`}>🔗</span>}
          <button type="button" className="button" onClick={() => onChange(null)}>Change</button>
        </div>
      ) : (
        <>
          <input
            className="brand-picker__input"
            placeholder="Search brands…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="brand-picker__list">
            <li>
              <button type="button" className="brand-picker__option" onClick={() => onChange(null)}>
                <span className="brand-picker__name">None — unbranded project</span>
              </button>
            </li>
            {filtered.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  className="brand-picker__option"
                  onClick={() => onChange({ id: b.id, applied_version: b.version })}
                >
                  <span className="brand-picker__name">{b.name}</span>
                  {b.id === data?.default_brand_id && <span>⭐</span>}
                  {b.forked_from && <span>🔗</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
```

CSS in `styles.css`:

```css
.brand-picker__input { width: 100%; padding: 6px 10px; border-radius: 5px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; }
.brand-picker__list { list-style: none; padding: 0; margin: 4px 0 0 0; max-height: 220px; overflow: auto; border: 1px solid #1e293b; border-radius: 6px; }
.brand-picker__option { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 6px 10px; background: transparent; color: inherit; border: none; cursor: pointer; }
.brand-picker__option:hover { background: #1e293b; }
.brand-picker__current { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid #1e293b; border-radius: 6px; background: #0f172a; }
```

- [ ] **Step 2: Integrate into NewProjectDialog**

Modify `apps/web/src/components/NewProjectDialog.tsx` (from Plan 01). Add a `brand` field to the form state initialized from the default brand, and embed `<BrandPicker>` near the bottom of the form:

```typescript
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BrandPicker } from './BrandPicker';
import { brandsApi } from '../lib/api';

// Inside the dialog component:
const { data: brandReg } = useQuery({ queryKey: ['brands'], queryFn: () => brandsApi.list() });
const [brand, setBrand] = useState<{ id: string; applied_version: number } | null>(null);

// Pre-select default once brand registry loads.
useEffect(() => {
  if (brandReg && brand === null && brandReg.default_brand_id) {
    const def = brandReg.brands.find((b) => b.id === brandReg.default_brand_id);
    if (def) setBrand({ id: def.id, applied_version: def.version });
  }
}, [brandReg, brand]);

// In the form JSX:
// <BrandPicker value={brand} onChange={setBrand} />

// On submit, include `brand` in the create-project payload (Plan 01's projects route may need extension).
```

If Plan 01's project create route doesn't accept a `brand` field yet, add it: extend `apps/server/src/routes/projects.ts` to accept and persist `brand` in `project.yaml`. Add a small test for the round-trip.

- [ ] **Step 3: Smoke test**

Run dev. Open new-project dialog: BrandPicker visible, lists existing brands, default pre-selected.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/BrandPicker.tsx \
        apps/web/src/components/NewProjectDialog.tsx \
        apps/web/src/styles.css \
        apps/server/src/routes/projects.ts
git commit -m "feat(web,projects): BrandPicker component with default pre-select; project create accepts brand"
```

---

## Task 17: New Brand wizard

**Files:**
- Replace stub: `apps/web/src/pages/BrandNew.tsx`
- Create: `apps/web/src/components/BrandSourceList.tsx` (small helper component)

- [ ] **Step 1: Implement the wizard page**

Replace `apps/web/src/pages/BrandNew.tsx`:

```typescript
import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { brandsApi, jobsApi } from '../lib/api';
import { BrandSourceList } from '../components/BrandSourceList';
import { BrandReviewForm } from '../components/BrandReviewForm';
import { BrandPreviewPane } from '../components/BrandPreviewPane';
import type { DesignMdFrontMatter } from '@vpa/shared';

type WizardStep = 'identify' | 'sources' | 'extracting' | 'review' | 'generating' | 'done';

interface UploadedSource {
  kind: 'file';
  file: File;
}

export default function BrandNew() {
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>('identify');
  const [name, setName] = useState('');
  const [files, setFiles] = useState<UploadedSource[]>([]);
  const [url, setUrl] = useState('');
  const [freeText, setFreeText] = useState('');
  const [progress, setProgress] = useState<string[]>([]);
  const [tokens, setTokens] = useState<DesignMdFrontMatter | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const closeStream = useRef<(() => void) | null>(null);
  const slugDerived = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

  const submitMutation = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append('name', name);
      if (freeText.trim()) form.append('free_text', freeText);
      if (url.trim())      form.append('url', url);
      for (const s of files) form.append('file', s.file, s.file.name);
      const res = await brandsApi.create(form);
      return res;
    },
    onSuccess: ({ job_id, slug }) => {
      setSlug(slug);
      setStep('extracting');
      closeStream.current = jobsApi.stream(job_id, (event) => {
        setProgress((p) => [...p, event.type]);
        if (event.type === 'tokens-ready') {
          const fm = (event.data as any)?.frontMatter as DesignMdFrontMatter;
          setTokens(fm);
          setStep('review');
          closeStream.current?.();
          closeStream.current = null;
        }
        if (event.type === 'error') {
          alert(`Extraction failed: ${(event.data as any)?.error}`);
        }
      });
    },
  });

  const generateMutation = useMutation({
    mutationFn: async (fm: DesignMdFrontMatter) => {
      if (!slug) throw new Error('No slug');
      return brandsApi.generate(slug, fm);
    },
    onSuccess: ({ job_id }) => {
      setStep('generating');
      const close = jobsApi.stream(job_id, (event) => {
        if (event.type === 'done') {
          close();
          if (slug) navigate(`/brands/${slug}`);
        }
        if (event.type === 'error') {
          alert(`Generation failed: ${(event.data as any)?.error}`);
        }
      });
    },
  });

  const onFilesPicked = useCallback((fl: FileList | null) => {
    if (!fl) return;
    const next = Array.from(fl).map((file): UploadedSource => ({ kind: 'file', file }));
    setFiles((prev) => [...prev, ...next]);
  }, []);

  if (step === 'review' && tokens) {
    return (
      <main className="brand-new brand-new--review">
        <header><h1>Review extracted brand: {name}</h1></header>
        <div className="brand-new__panes">
          <BrandReviewForm
            value={tokens}
            onChange={setTokens}
          />
          <BrandPreviewPane frontMatter={tokens} body="" />
        </div>
        <footer className="brand-new__actions">
          <button type="button" className="button" onClick={() => navigate('/')}>Cancel</button>
          <button
            type="button"
            className="button button--primary"
            disabled={generateMutation.isPending}
            onClick={() => generateMutation.mutate(tokens)}
          >
            {generateMutation.isPending ? 'Generating…' : 'Generate design.md'}
          </button>
        </footer>
      </main>
    );
  }

  return (
    <main className="brand-new">
      <header><h1>New Brand</h1></header>

      <section className="section">
        <label className="label">Name</label>
        <input
          className="brand-picker__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Tanzu"
        />
        {slugDerived && <p className="hint">slug: <code>{slugDerived}</code></p>}
      </section>

      <section className="section">
        <h2>Sources</h2>
        <p className="hint">Drop PDF, MD, or existing design.md files. Or paste a URL. Or write a description below. Combine any of these.</p>

        <input
          type="file"
          multiple
          accept=".pdf,.md,.markdown,.txt"
          onChange={(e) => onFilesPicked(e.target.files)}
        />
        <BrandSourceList files={files} onRemove={(idx) => setFiles((p) => p.filter((_, i) => i !== idx))} />

        <label className="label">URL</label>
        <input className="brand-picker__input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/brand" />

        <label className="label">Or describe the brand</label>
        <textarea
          className="brand-picker__input"
          rows={6}
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="Confident, technical, optimistic. Primary color is teal blue. Inter for headings…"
        />
      </section>

      {step === 'extracting' && (
        <section className="section">
          <h2>Extracting…</h2>
          <ul className="progress">
            {progress.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </section>
      )}

      <footer className="brand-new__actions">
        <button type="button" className="button" onClick={() => navigate('/')}>Cancel</button>
        <button
          type="button"
          className="button button--primary"
          disabled={!name || (files.length === 0 && !url.trim() && !freeText.trim()) || submitMutation.isPending || step === 'extracting'}
          onClick={() => submitMutation.mutate()}
        >
          {submitMutation.isPending ? 'Submitting…' : 'Extract'}
        </button>
      </footer>
    </main>
  );
}
```

- [ ] **Step 2: Implement BrandSourceList**

Create `apps/web/src/components/BrandSourceList.tsx`:

```typescript
interface Props {
  files: { file: File }[];
  onRemove: (idx: number) => void;
}

export function BrandSourceList({ files, onRemove }: Props) {
  if (files.length === 0) return null;
  return (
    <ul className="source-list">
      {files.map((s, i) => (
        <li key={`${s.file.name}-${i}`}>
          <span>{s.file.name} <small>({Math.round(s.file.size / 1024)} KB)</small></span>
          <button type="button" className="button" onClick={() => onRemove(i)}>Remove</button>
        </li>
      ))}
    </ul>
  );
}
```

CSS:

```css
.source-list { list-style: none; padding: 0; margin: 8px 0; display: flex; flex-direction: column; gap: 4px; }
.source-list li { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: #0f172a; border: 1px solid #1e293b; border-radius: 5px; }
.brand-new__panes { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.brand-new__actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.progress { list-style: none; padding: 0; margin: 8px 0; font-family: monospace; font-size: 12px; color: #94a3b8; }
.hint { color: #94a3b8; font-size: 12px; margin: 4px 0; }
```

- [ ] **Step 3: Smoke test (this depends on Task 18's components — write stubs first)**

Create stubs so this page compiles:

`apps/web/src/components/BrandReviewForm.tsx`:

```typescript
import type { DesignMdFrontMatter } from '@vpa/shared';
interface Props { value: DesignMdFrontMatter; onChange: (next: DesignMdFrontMatter) => void; }
export function BrandReviewForm({ value }: Props) {
  return <pre style={{ fontSize: 11, color: '#94a3b8' }}>{JSON.stringify(value, null, 2)}</pre>;
}
```

`apps/web/src/components/BrandPreviewPane.tsx`:

```typescript
import type { DesignMdFrontMatter } from '@vpa/shared';
interface Props { frontMatter: DesignMdFrontMatter; body: string; }
export function BrandPreviewPane({ frontMatter }: Props) {
  return <div className="placeholder">Preview pane (full impl in Task 18)<br/><code>{frontMatter.name}</code></div>;
}
```

Run dev. Click "+ New Brand", fill name = "Acme", paste free-text "Acme is bold". Click Extract. Expect to see progress events stream then the review screen with token JSON dumped (stub).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/BrandNew.tsx \
        apps/web/src/components/BrandSourceList.tsx \
        apps/web/src/components/BrandReviewForm.tsx \
        apps/web/src/components/BrandPreviewPane.tsx \
        apps/web/src/styles.css
git commit -m "feat(web): New Brand wizard with multi-source upload, SSE progress, review handoff"
```

---

## Task 18: Brand Review Form + Preview Pane (full implementations)

**Files:**
- Replace stub: `apps/web/src/components/BrandReviewForm.tsx`
- Replace stub: `apps/web/src/components/BrandPreviewPane.tsx`
- Modify: `apps/web/package.json` (add `react-markdown`)

- [ ] **Step 1: Add react-markdown**

```bash
npm --workspace apps/web install react-markdown@9
```

- [ ] **Step 2: Implement BrandReviewForm**

Replace `apps/web/src/components/BrandReviewForm.tsx`:

```typescript
import type { DesignMdFrontMatter } from '@vpa/shared';

interface Props {
  value: DesignMdFrontMatter;
  onChange: (next: DesignMdFrontMatter) => void;
}

export function BrandReviewForm({ value, onChange }: Props) {
  const setColor = (key: keyof DesignMdFrontMatter['colors'] | string, hex: string) => {
    onChange({ ...value, colors: { ...value.colors, [key]: hex } });
  };
  const setHeadingFamily = (family: string) => {
    onChange({ ...value, typography: { ...value.typography, heading: { ...value.typography.heading, family } } });
  };
  const setBodyFamily = (family: string) => {
    onChange({ ...value, typography: { ...value.typography, body: { ...value.typography.body, family } } });
  };
  const setVoiceTone = (tone: string) => {
    const cur = value.vpa ?? defaultVpa();
    onChange({ ...value, vpa: { ...cur, voice: { ...cur.voice, tone } } });
  };
  const setLowerThirdsTemplate = (template: 'bar-left-accent' | 'centered-fade' | 'minimal-line') => {
    const cur = value.vpa ?? defaultVpa();
    onChange({ ...value, vpa: { ...cur, lower_thirds: { ...cur.lower_thirds, template } } });
  };
  const setTagline = (idx: number, text: string) => {
    const cur = value.vpa ?? defaultVpa();
    const next = [...cur.taglines];
    next[idx] = text;
    onChange({ ...value, vpa: { ...cur, taglines: next } });
  };
  const addTagline = () => {
    const cur = value.vpa ?? defaultVpa();
    onChange({ ...value, vpa: { ...cur, taglines: [...cur.taglines, ''] } });
  };

  const colorEntries = Object.entries(value.colors);

  return (
    <form className="review-form" onSubmit={(e) => e.preventDefault()}>
      <fieldset>
        <legend>Identity</legend>
        <label>Name</label>
        <input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
        <label>Description</label>
        <input value={value.description ?? ''} onChange={(e) => onChange({ ...value, description: e.target.value })} />
      </fieldset>

      <fieldset>
        <legend>Colors</legend>
        <div className="color-grid">
          {colorEntries.map(([name, hex]) => (
            <div className="color-row" key={name}>
              <span className="color-swatch" style={{ background: hex }} />
              <span className="color-name">{name}</span>
              <input className="color-input" value={hex} onChange={(e) => setColor(name, e.target.value)} />
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Typography</legend>
        <label>Heading family</label>
        <input value={value.typography.heading.family} onChange={(e) => setHeadingFamily(e.target.value)} />
        <label>Body family</label>
        <input value={value.typography.body.family} onChange={(e) => setBodyFamily(e.target.value)} />
      </fieldset>

      <fieldset>
        <legend>Voice & Tone</legend>
        <textarea
          rows={3}
          value={value.vpa?.voice.tone ?? ''}
          onChange={(e) => setVoiceTone(e.target.value)}
        />
      </fieldset>

      <fieldset>
        <legend>Lower-thirds</legend>
        <select
          value={value.vpa?.lower_thirds.template ?? 'bar-left-accent'}
          onChange={(e) => setLowerThirdsTemplate(e.target.value as any)}
        >
          <option value="bar-left-accent">bar-left-accent</option>
          <option value="centered-fade">centered-fade</option>
          <option value="minimal-line">minimal-line</option>
        </select>
      </fieldset>

      <fieldset>
        <legend>Taglines</legend>
        {(value.vpa?.taglines ?? []).map((t, i) => (
          <input key={i} value={t} onChange={(e) => setTagline(i, e.target.value)} />
        ))}
        <button type="button" className="button" onClick={addTagline}>+ Add tagline</button>
      </fieldset>
    </form>
  );
}

function defaultVpa() {
  return {
    voice: { tone: '', avoid: [] },
    audio: { music_mood: null, sonic_logo: null },
    logo: { primary: null, mono: null, safe_zone_ratio: 0.25 },
    lower_thirds: { template: 'bar-left-accent' as const, bg: '{colors.primary}', fg: '{colors.surface}' },
    taglines: [],
  };
}
```

CSS:

```css
.review-form fieldset { border: 1px solid #1e293b; border-radius: 6px; padding: 10px; margin-bottom: 12px; }
.review-form legend { padding: 0 6px; color: #94a3b8; font-size: 12px; }
.review-form label { display: block; font-size: 11px; color: #94a3b8; margin-top: 6px; }
.review-form input, .review-form textarea, .review-form select {
  width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0;
}
.color-grid { display: grid; gap: 6px; grid-template-columns: 1fr 1fr; }
.color-row { display: flex; align-items: center; gap: 6px; }
.color-swatch { width: 22px; height: 22px; border-radius: 4px; border: 1px solid #334155; }
.color-name { font-size: 11px; color: #94a3b8; min-width: 70px; }
.color-input { font-family: monospace; font-size: 11px; }
```

- [ ] **Step 3: Implement BrandPreviewPane**

Replace `apps/web/src/components/BrandPreviewPane.tsx`:

```typescript
import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { DesignMdFrontMatter } from '@vpa/shared';

interface Props {
  frontMatter: DesignMdFrontMatter;
  body: string;
}

export function BrandPreviewPane({ frontMatter, body }: Props) {
  const [tab, setTab] = useState<'visual' | 'markdown'>('visual');

  const lowerThirdBg = resolve(frontMatter.vpa?.lower_thirds.bg ?? '#000000', frontMatter.colors);
  const lowerThirdFg = resolve(frontMatter.vpa?.lower_thirds.fg ?? '#ffffff', frontMatter.colors);

  const yamlText = useMemo(() => quickYaml(frontMatter), [frontMatter]);

  return (
    <div className="preview-pane">
      <nav className="preview-tabs">
        <button className={tab === 'visual'   ? 'active' : ''} onClick={() => setTab('visual')}>Visual</button>
        <button className={tab === 'markdown' ? 'active' : ''} onClick={() => setTab('markdown')}>Markdown</button>
      </nav>

      {tab === 'visual' ? (
        <div className="preview-body">
          <h3>Color palette</h3>
          <div className="palette">
            {Object.entries(frontMatter.colors).map(([name, hex]) => (
              <div key={name} className="palette-cell" style={{ background: hex }}>
                <span style={{ color: contrastColor(hex) }}>{hex}</span>
              </div>
            ))}
          </div>

          <h3>Type sample</h3>
          <div className="type-sample" style={{ background: frontMatter.colors.surface, color: frontMatter.colors.on_surface }}>
            <div style={{ fontFamily: frontMatter.typography.heading.family, fontWeight: frontMatter.typography.heading.weights[0], fontSize: 22 }}>
              {frontMatter.vpa?.taglines[0] ?? frontMatter.name}
            </div>
            <div style={{ fontFamily: frontMatter.typography.body.family, fontSize: 13, marginTop: 4 }}>
              {frontMatter.vpa?.voice.tone ?? frontMatter.description ?? 'Body text using brand fonts.'}
            </div>
          </div>

          <h3>Lower-third</h3>
          <div className="lower-third-mock">
            <div className="lower-third-bar" style={{ background: lowerThirdBg, color: lowerThirdFg }}>
              <strong>Speaker Name</strong>
              <small>Title · {frontMatter.name}</small>
            </div>
          </div>
        </div>
      ) : (
        <div className="preview-body markdown">
          <pre className="design-md-source">---{`\n`}{yamlText}---{`\n\n`}</pre>
          {body && <ReactMarkdown>{body}</ReactMarkdown>}
          {!body && <p className="hint"><em>Prose body fills in after Generate.</em></p>}
        </div>
      )}
    </div>
  );
}

function resolve(value: string, colors: Record<string, string>): string {
  const m = value.match(/^\{colors\.([a-z_]+)\}$/);
  if (m) return colors[m[1]] ?? value;
  return value;
}

function contrastColor(hex: string): string {
  // Quick luminance check.
  const c = hex.replace('#', '');
  if (c.length < 6) return '#fff';
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum > 0.55 ? '#1A1C1E' : '#FFFFFF';
}

function quickYaml(o: unknown, indent = 0): string {
  // Tiny YAML serializer, only for preview purposes.
  const pad = '  '.repeat(indent);
  if (Array.isArray(o)) {
    return o.map((v) => `${pad}- ${typeof v === 'object' ? '\n' + quickYaml(v, indent + 1) : JSON.stringify(v)}`).join('\n');
  }
  if (o && typeof o === 'object') {
    return Object.entries(o as Record<string, unknown>)
      .map(([k, v]) => {
        if (v && typeof v === 'object') return `${pad}${k}:\n${quickYaml(v, indent + 1)}`;
        return `${pad}${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`;
      })
      .join('\n') + '\n';
  }
  return String(o);
}
```

CSS:

```css
.preview-pane { background: #0b1120; border: 1px solid #1e293b; border-radius: 6px; min-height: 520px; display: flex; flex-direction: column; }
.preview-tabs { display: flex; border-bottom: 1px solid #1e293b; }
.preview-tabs button { padding: 8px 14px; background: transparent; color: #64748b; border: none; cursor: pointer; }
.preview-tabs button.active { color: #e2e8f0; border-bottom: 2px solid #6366f1; }
.preview-body { padding: 14px; overflow: auto; }
.palette { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 16px; }
.palette-cell { height: 50px; border-radius: 5px; display: flex; align-items: flex-end; padding: 4px; font-family: monospace; font-size: 10px; }
.type-sample { padding: 12px; border-radius: 5px; margin-bottom: 16px; }
.lower-third-mock { background: #1A1C1E; border-radius: 5px; height: 100px; display: flex; align-items: flex-end; padding: 14px 0; }
.lower-third-bar { padding: 8px 18px 8px 12px; border-left: 4px solid currentColor; display: flex; flex-direction: column; }
.design-md-source { background: #1e293b; padding: 10px; border-radius: 4px; font-size: 11px; white-space: pre-wrap; color: #cbd5e1; }
```

- [ ] **Step 4: Smoke test**

Run dev. Walk through New Brand wizard. The review screen should show:
- Left: structured form with editable fields, color swatches updating live
- Right: Visual tab with palette + type sample + lower-third mock; switching to Markdown tab shows YAML front matter

Click Generate. Expect navigation to `/brands/<slug>` (still showing the stub from Task 15 until Task 19 lands).

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/package-lock.json \
        apps/web/src/components/BrandReviewForm.tsx \
        apps/web/src/components/BrandPreviewPane.tsx \
        apps/web/src/styles.css
git commit -m "feat(web): brand review form and live preview pane (Visual + Markdown tabs)"
```

---

## Task 19: Brand Detail page

**Files:**
- Replace stub: `apps/web/src/pages/BrandDetail.tsx`

- [ ] **Step 1: Implement BrandDetail**

Replace `apps/web/src/pages/BrandDetail.tsx`:

```typescript
import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { brandsApi } from '../lib/api';
import { BrandPreviewPane } from '../components/BrandPreviewPane';

type Tab = 'overview' | 'tokens' | 'markdown' | 'assets' | 'usage';

export default function BrandDetail() {
  const { slug } = useParams<{ slug: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('overview');

  const { data, isLoading, error } = useQuery({
    queryKey: ['brand', slug],
    queryFn: () => brandsApi.detail(slug!),
    enabled: !!slug,
  });

  const { data: registry } = useQuery({
    queryKey: ['brands'],
    queryFn: () => brandsApi.list(),
  });

  const setDefaultMutation = useMutation({
    mutationFn: (next: boolean) => brandsApi.setDefault(slug!, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brands'] }),
  });

  const forkMutation = useMutation({
    mutationFn: (name: string) => brandsApi.fork(slug!, name),
    onSuccess: (fork) => {
      qc.invalidateQueries({ queryKey: ['brands'] });
      navigate(`/brands/${fork.registry.id}`);
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: () => brandsApi.regenerate(slug!),
    onSuccess: () => {
      // Could subscribe to job stream for progress; here we just invalidate the brand after a delay.
      setTimeout(() => qc.invalidateQueries({ queryKey: ['brand', slug] }), 1500);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      try { await brandsApi.delete(slug!); }
      catch (err: any) {
        if (err.code === 'in-use') {
          const projects = err.referencing_projects.map((p: any) => p.name).join(', ');
          if (!confirm(`Brand is used by: ${projects}. Force delete?`)) return;
          await brandsApi.delete(slug!, true);
        } else {
          throw err;
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brands'] });
      navigate('/');
    },
  });

  if (isLoading) return <main><p>Loading…</p></main>;
  if (error || !data) return <main><p>Failed to load brand.</p></main>;

  const isDefault = registry?.default_brand_id === slug;
  const isFork = data.registry.forked_from !== null;

  return (
    <main className="brand-detail">
      <header className="brand-detail__header">
        <h1>{data.registry.name}</h1>
        <span className="brand-detail__meta">
          v{data.registry.version}
          {isFork && <> · 🔗 fork of <Link to={`/brands/${data.registry.forked_from}`}>{data.registry.forked_from}</Link></>}
        </span>

        <label className="brand-detail__default">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setDefaultMutation.mutate(e.target.checked)}
          />
          Default brand · auto-applied to new projects
        </label>
      </header>

      <div className="brand-detail__actions">
        <a className="button" href={brandsApi.download(slug!)} download>Download design.md</a>
        <button className="button" onClick={() => regenerateMutation.mutate()} disabled={regenerateMutation.isPending}>
          {regenerateMutation.isPending ? 'Regenerating…' : 'Regenerate'}
        </button>
        <button className="button" onClick={() => {
          const name = prompt('Fork name:', `${data.registry.name} · Copy`);
          if (name) forkMutation.mutate(name);
        }}>Fork</button>
        <button
          className="button button--danger"
          onClick={() => {
            if (confirm('Delete this brand?')) deleteMutation.mutate();
          }}
        >Delete</button>
      </div>

      <nav className="brand-detail__tabs">
        {(['overview', 'tokens', 'markdown', 'assets', 'usage'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>

      <section className="brand-detail__content">
        {tab === 'overview' && <BrandPreviewPane frontMatter={data.doc.frontMatter} body={data.doc.body} />}
        {tab === 'tokens'   && <TokensTable frontMatter={data.doc.frontMatter} />}
        {tab === 'markdown' && <pre className="design-md-source">{serializeForView(data)}</pre>}
        {tab === 'assets'   && <AssetsPane slug={slug!} frontMatter={data.doc.frontMatter} />}
        {tab === 'usage'    && <UsagePane slug={slug!} />}
      </section>
    </main>
  );
}

function TokensTable({ frontMatter }: { frontMatter: any }) {
  const rows = flatten(frontMatter);
  return (
    <table className="tokens-table">
      <thead><tr><th>Path</th><th>Value</th></tr></thead>
      <tbody>
        {rows.map(([path, value]) => (
          <tr key={path}><td><code>{path}</code></td><td>{String(value)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function flatten(obj: any, prefix = ''): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, path));
    else out.push([path, v]);
  }
  return out;
}

function serializeForView(data: any): string {
  // Roughly reconstruct the on-disk file for the markdown tab.
  return `---\n${JSON.stringify(data.doc.frontMatter, null, 2)}\n---\n\n${data.doc.body}`;
}

function AssetsPane({ slug, frontMatter }: { slug: string; frontMatter: any }) {
  const qc = useQueryClient();
  const upload = useMutation({
    mutationFn: ({ field, file }: { field: 'primary' | 'mono'; file: File }) =>
      brandsApi.uploadAsset(slug, file, field),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brand', slug] }),
  });
  return (
    <div>
      <h3>Logo · primary</h3>
      <p>{frontMatter.vpa?.logo.primary ?? <em>not set</em>}</p>
      <input type="file" accept=".svg,.png" onChange={(e) => e.target.files && upload.mutate({ field: 'primary', file: e.target.files[0] })} />

      <h3>Logo · mono</h3>
      <p>{frontMatter.vpa?.logo.mono ?? <em>not set</em>}</p>
      <input type="file" accept=".svg,.png" onChange={(e) => e.target.files && upload.mutate({ field: 'mono', file: e.target.files[0] })} />
    </div>
  );
}

function UsagePane({ slug }: { slug: string }) {
  // Reads the project list from Plan 01's projects API and filters to those using this brand.
  // For now, simple list — future iteration can show pinned vs current version.
  const { data } = useQuery({
    queryKey: ['projects-using-brand', slug],
    queryFn: async () => {
      const r = await fetch('/api/projects');
      if (!r.ok) return { projects: [] };
      return r.json();
    },
  });
  const matches = (data?.projects ?? []).filter((p: any) => p.brand?.id === slug);
  if (matches.length === 0) return <p className="hint">No projects use this brand yet.</p>;
  return (
    <ul>
      {matches.map((p: any) => <li key={p.id}><Link to={`/projects/${p.id}`}>{p.name}</Link></li>)}
    </ul>
  );
}
```

CSS:

```css
.brand-detail__header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.brand-detail__meta { color: #94a3b8; font-size: 13px; }
.brand-detail__default { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #94a3b8; }
.brand-detail__actions { display: flex; gap: 8px; margin: 16px 0; }
.button--danger { background: #b91c1c; border-color: #b91c1c; }
.brand-detail__tabs { display: flex; gap: 4px; border-bottom: 1px solid #1e293b; margin-bottom: 14px; }
.brand-detail__tabs button { padding: 6px 12px; background: transparent; color: #64748b; border: none; border-bottom: 2px solid transparent; cursor: pointer; }
.brand-detail__tabs button.active { color: #e2e8f0; border-bottom-color: #6366f1; }
.tokens-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.tokens-table td, .tokens-table th { padding: 4px 8px; border-bottom: 1px solid #1e293b; text-align: left; }
```

- [ ] **Step 2: Smoke test**

Walk through wizard end-to-end → land on detail. Tabs work. Default toggle persists. Download button serves the file. Fork creates a new brand. Delete works (with project guard if a project references it).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/BrandDetail.tsx apps/web/src/styles.css
git commit -m "feat(web): Brand Detail page with tabs, default toggle, download, fork, regenerate, delete"
```

---

## Task 20: Brand-update banner on project pages

**Files:**
- Create: `apps/web/src/components/BrandUpdateBanner.tsx`
- Modify: `apps/web/src/pages/Project.tsx` (or wherever Plan 01 surfaces project detail) — embed banner

- [ ] **Step 1: Implement BrandUpdateBanner**

Create `apps/web/src/components/BrandUpdateBanner.tsx`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { brandsApi } from '../lib/api';

interface Props {
  projectId: string;
  brandId: string;
  appliedVersion: number;
}

export function BrandUpdateBanner({ projectId, brandId, appliedVersion }: Props) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['brand', brandId],
    queryFn: () => brandsApi.detail(brandId),
    enabled: !!brandId,
  });
  const apply = useMutation({
    mutationFn: async (newVersion: number) => {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: { id: brandId, applied_version: newVersion } }),
      });
      if (!res.ok) throw new Error(`Apply failed: ${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });

  if (!data) return null;
  if (data.registry.version <= appliedVersion) return null;

  return (
    <aside className="banner banner--info">
      <span>
        <strong>{data.registry.name}</strong> was updated to v{data.registry.version}
        <span className="hint"> (project last applied v{appliedVersion}).</span>
      </span>
      <button className="button button--primary" onClick={() => apply.mutate(data.registry.version)}>
        Apply
      </button>
      <button className="button" onClick={() => apply.mutate(data.registry.version)}>
        Dismiss
      </button>
    </aside>
  );
}
```

(Apply and Dismiss share the same handler — both update `applied_version` to silence the banner. The spec calls them out as separate UI affordances for clarity; they have the same effect, since live reads always return the current brand content.)

CSS:

```css
.banner { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 6px; margin-bottom: 14px; }
.banner--info { background: #1e293b; border: 1px solid #6366f1; color: #e2e8f0; }
```

- [ ] **Step 2: Embed in project detail page**

Modify whatever page in Plan 01 shows project detail (likely `apps/web/src/pages/Dashboard.tsx` for the project row, or a `Project.tsx` if Plan 01 created one). Where the project's brand is rendered:

```typescript
{project.brand && (
  <BrandUpdateBanner
    projectId={project.id}
    brandId={project.brand.id}
    appliedVersion={project.brand.applied_version}
  />
)}
```

If Plan 01's projects PUT route doesn't yet accept brand updates, extend it: read body's `brand` field, validate it points to an existing brand, persist.

- [ ] **Step 3: Smoke test**

Create a brand, attach to a project. Edit the brand's tokens (in BrandDetail's review form via a "regenerate" pass) so version bumps. Open the project page. Banner appears. Click Apply. Banner disappears.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/BrandUpdateBanner.tsx \
        apps/web/src/pages/Project.tsx apps/web/src/pages/Dashboard.tsx \
        apps/web/src/styles.css \
        apps/server/src/routes/projects.ts
git commit -m "feat(web): brand-update banner with Apply/Dismiss"
```

---

## Task 21: End-to-end Playwright test + README + final verification

**Files:**
- Create: `tests/e2e/brand-creation.spec.ts`
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Write the e2e test**

Create `tests/e2e/brand-creation.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test('create brand from free text and apply to project', async ({ page }) => {
  await page.goto('http://localhost:5173/');

  // Navigate to New Brand wizard.
  await page.getByRole('link', { name: /\+ New Brand/ }).click();
  await expect(page).toHaveURL(/\/brands\/new/);

  // Fill identity + free text.
  await page.getByLabel('Name').fill('Acme Test Brand');
  await page.getByPlaceholder(/describe the brand/i).fill('Acme is bold and clean. Primary color teal blue. Inter for headings.');

  // Click Extract.
  await page.getByRole('button', { name: /^Extract$/ }).click();

  // Wait for review screen.
  await expect(page.getByRole('heading', { name: /Review extracted brand/ })).toBeVisible({ timeout: 30_000 });

  // Visual tab default; verify a color swatch appears.
  await expect(page.locator('.palette-cell').first()).toBeVisible();

  // Click Generate.
  await page.getByRole('button', { name: /Generate design\.md/ }).click();

  // Land on detail page.
  await expect(page).toHaveURL(/\/brands\/acme-test-brand/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Acme Test Brand' })).toBeVisible();

  // Toggle default.
  await page.getByLabel(/Default brand/).check();

  // Download link is reachable.
  const dl = page.getByRole('link', { name: /Download design\.md/ });
  await expect(dl).toHaveAttribute('href', /\/api\/brands\/acme-test-brand\/download/);
});

test('fork creates a new brand and navigates to it', async ({ page }) => {
  await page.goto('http://localhost:5173/');
  // Assume the brand from previous test exists. Click on it.
  await page.getByRole('link', { name: /Acme Test Brand/ }).click();
  page.once('dialog', async (d) => { await d.accept('Acme Test Brand · Q4'); });
  await page.getByRole('button', { name: /Fork/ }).click();
  await expect(page).toHaveURL(/\/brands\/acme-test-brand--q4/, { timeout: 10_000 });
  await expect(page.getByText(/fork of acme-test-brand/)).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e tests**

Start dev servers, then:

Run: `npm --workspace tests/e2e exec playwright test brand-creation`
Expected: PASS, 2 tests passing.

- [ ] **Step 3: Update README**

Modify `README.md` — add a "Brand Library" section after the project setup section:

```markdown
## Brand Library

VPA's Brand Library lets you create reusable brand profiles from documents (PDF, markdown, URL, free text, or existing design.md files). Each brand is stored as a Google Labs [`design.md`](https://github.com/google-labs-code/design.md) file extended with VPA-specific fields under a `vpa:` namespace.

### Optional: install MarkItDown for higher-quality extraction

VPA ships with native PDF and URL extractors as a fallback, but PDF brand guidelines are typically better parsed by Microsoft's [MarkItDown](https://github.com/microsoft/markitdown), which produces cleaner LLM-ready markdown. To enable it:

```bash
# Requires Python 3.10+
pip install 'markitdown[all]'
# or with uv:
uv tool install markitdown
```

Restart the VPA server after installing. The Settings page will reflect detection status.

### Where brands live

- Brand directories: `brands/<slug>/design.md`
- Registry: `apps/server/.vpa/brands.json`
- Editable LLM prompts: `prompts/brand-extract-tokens.md`, `prompts/brand-write-rationale.md`

### LLM provider

The current build uses a fake LLM provider that returns a deterministic design.md for development. Real provider implementations (Gemini, Claude, xAI) are in a follow-on plan.
```

- [ ] **Step 4: Update .env.example**

Modify `.env.example`:

```dotenv
# Brand generation — LLM provider configuration.
# Currently only "fake" is supported; real providers come in a follow-on plan.
VPA_LLM_PROVIDER=fake
# When real providers land, set their API keys here:
# GEMINI_API_KEY=
# ANTHROPIC_API_KEY=
```

- [ ] **Step 5: Run full test suite**

```bash
npm --workspace packages/shared test
npm --workspace apps/server test
npm --workspace tests/e2e exec playwright test
```

Expected: ALL PASS.

- [ ] **Step 6: Final verification checklist**

Walk through these from a clean dev start:

1. `npm install`
2. `npm run dev`
3. Dashboard loads with empty Brands section
4. Click "+ New Brand", create a brand from free text. Wizard advances through extracting → review → generating → detail.
5. Brand detail page shows palette, type sample, lower-third mock; tabs work; Download serves a file.
6. Toggle Default. Reload — default ⭐ visible on dashboard card.
7. Fork the brand. New brand appears with 🔗 badge, parented to original.
8. Create a new project; default brand is pre-selected in BrandPicker.
9. Hand-edit the brand's design.md on disk to bump `version`. Reload project page. Banner appears. Click Apply. Banner disappears.
10. Try to delete a brand referenced by a project — get the project-guard prompt.
11. With MarkItDown installed, upload a real PDF. Confirm extraction quality is markedly better than fallback.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/brand-creation.spec.ts README.md .env.example
git commit -m "test(e2e): brand creation, default, fork flows; docs: MarkItDown prereq"
```

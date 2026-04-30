# Plan 01 — Foundation & Project Store

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the VPA workspace (Fastify server + Vite/React studio), a typed shared package, and a working project tracker so a user can create, list, and "open folder" projects from the dashboard. No video features yet — this plan delivers the skeleton that every later plan builds on.

**Architecture:** npm workspaces monorepo with three packages: `apps/server` (Fastify + zod + js-yaml), `apps/web` (Vite + React + TanStack Query + react-router), `packages/shared` (zod schemas + types consumed by both). Services in the server are pure modules; route handlers are thin adapters. Disk layout uses `~/.vpa/projects.json` as the project tracker and `<project root>/project.yaml` as per-project metadata.

**Tech Stack:**
- Node 20+, TypeScript 5
- Server: Fastify 4, zod 3, js-yaml 4, uuid 9
- Web: Vite 5, React 18, TanStack Query 5, react-router 6, TypeScript
- Testing: Vitest 1 (unit), Playwright 1 (E2E)
- Lint/format: ESLint + Prettier (minimal config)

**Spec reference:** `docs/superpowers/specs/2026-04-29-vpa-phase1-design.md`, sections 3.5 (repo layout), 4.1 (storage layout), 5.2 (dashboard), 8 (security).

---

## File Structure (created in this plan)

```
package.json                              workspace root
tsconfig.base.json                        shared TS config
.eslintrc.cjs                             minimal lint
.prettierrc.json
README.md                                 run instructions
.env.example

packages/shared/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                          re-exports
    ├── project.ts                        Project zod schema + types
    └── api.ts                            shared API request/response types

apps/server/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── server.ts                         Fastify bootstrap
    ├── config.ts                         env + paths (~/.vpa)
    ├── routes/
    │   ├── health.ts
    │   └── projects.ts                   list / create / import
    ├── services/
    │   └── project/
    │       ├── store.ts                  pure CRUD on tracker + project.yaml
    │       ├── store.test.ts
    │       └── paths.ts                  default-folder logic
    └── lib/
        ├── yaml.ts                       js-yaml load/save with safe schema
        └── fs-atomic.ts                  atomic write (tmp + rename)

apps/web/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
└── src/
    ├── main.tsx                          React + Router + QueryClient bootstrap
    ├── App.tsx                           routes
    ├── lib/
    │   └── api.ts                        typed fetch client
    ├── pages/
    │   └── Dashboard.tsx
    ├── components/
    │   ├── ProjectList.tsx
    │   ├── NewProjectDialog.tsx
    │   └── OpenFolderDialog.tsx
    └── styles.css                        minimal CSS (dark theme baseline)

tests/
└── e2e/
    ├── playwright.config.ts
    └── dashboard.spec.ts                 smoke: create + list project
```

---

## Task 1: Workspace bootstrap

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`  (ESLint 9 flat config — `.eslintrc.*` is deprecated)
- Create: `.prettierrc.json`
- Create: `README.md`
- Create: `.env.example`
- Modify: `.gitignore` (add `dist/`, `node_modules/` already covered)

- [ ] **Step 1: Create the workspace root `package.json`**

```json
{
  "name": "video-production-assistant",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "dev": "npm run dev --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "lint": "eslint . --max-warnings=0 --no-error-on-unmatched-pattern",
    "format": "prettier --write \"**/*.{ts,tsx,json,md,yaml,yml}\"",
    "typecheck": "tsc -b",
    "e2e": "playwright test"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@playwright/test": "^1.48.0",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^10.0.0",
    "prettier": "^3.3.0",
    "typescript": "^5.6.0",
    "typescript-eslint": "^8.0.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "incremental": true
  },
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `eslint.config.js`** (ESLint 9 flat config)

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier/flat';

export default [
  { ignores: ['dist/', 'node_modules/', '**/*.cjs', '**/*.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
```

Note: ESLint 9 deprecated `.eslintrc.*` — flat config (`eslint.config.js`) is the only config format auto-discovered. `typescript-eslint` (the unified meta-package) replaces the older `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` pair. `eslint-config-prettier/flat` is the flat-config export of `eslint-config-prettier`.

- [ ] **Step 4: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always"
}
```

- [ ] **Step 5: Create `README.md`**

```markdown
# Video Production Assistant

Greenfield desktop studio that speeds up post-recording demo video creation. See `docs/superpowers/specs/` for design.

## Prerequisites

- Node 20+
- npm 10+

## Install

```bash
npm install
```

## Development

```bash
npm run dev          # runs each workspace's dev script (parallel runner added in Task 17)
npm run build        # build all packages
npm run test         # unit tests across workspaces
npm run e2e          # Playwright smoke tests (requires `npm run dev` running)
npm run typecheck    # tsc -b
npm run lint
```

## Environment

Copy `.env.example` to `.env` and adjust if needed. All defaults work for local single-user use.
```

- [ ] **Step 6: Create `.env.example`**

```
# Where VPA stores app config (tracker, brands, voices, prompts cache)
VPA_HOME=~/.vpa

# Default folder root for new projects
VPA_PROJECTS_DEFAULT=~/Movies/VPA

# Server
VPA_SERVER_PORT=3000
VPA_SERVER_HOST=127.0.0.1

# Web (Vite reads VITE_* prefix)
VITE_VPA_API_BASE=http://localhost:3000
```

- [ ] **Step 7: Verify gitignore covers build artifacts**

Run: `grep -E "node_modules|dist" .gitignore`

Expected: both lines present (already added in initial commit).

- [ ] **Step 8: Install dependencies**

Run: `npm install`

Expected: clean install with no errors. `node_modules/` and `package-lock.json` created.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.base.json eslint.config.js .prettierrc.json README.md .env.example package-lock.json
git commit -m "chore: bootstrap npm workspace with TS/ESLint/Prettier baseline"
```

---

## Task 2: Shared package with Project schema

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/project.ts`
- Create: `packages/shared/src/api.ts`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@vpa/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty"
  },
  "dependencies": {
    "zod": "^3.23.0"
  }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/shared/src/project.ts`**

```ts
import { z } from 'zod';

/** Project metadata stored in <project root>/project.yaml */
export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, 'name must be alphanumeric with - or _'),
  path: z.string().min(1), // absolute filesystem path
  created: z.string().datetime(),
  objective: z.string().optional(),
  audience: z.string().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** Tracker entry in ~/.vpa/projects.json */
export const ProjectTrackerEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  path: z.string(),
  lastOpened: z.string().datetime().nullable(),
});
export type ProjectTrackerEntry = z.infer<typeof ProjectTrackerEntrySchema>;

export const ProjectTrackerSchema = z.object({
  version: z.literal(1),
  projects: z.array(ProjectTrackerEntrySchema),
});
export type ProjectTracker = z.infer<typeof ProjectTrackerSchema>;
```

- [ ] **Step 4: Create `packages/shared/src/api.ts`**

```ts
import { z } from 'zod';
import { ProjectSchema, ProjectTrackerEntrySchema } from './project.js';

export const CreateProjectRequestSchema = z.object({
  name: ProjectSchema.shape.name,
  /** Absolute path to the parent directory; project will be created at <parent>/<name>. Optional — server uses VPA_PROJECTS_DEFAULT if omitted. */
  parentDir: z.string().optional(),
  objective: z.string().optional(),
  audience: z.string().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ImportProjectRequestSchema = z.object({
  /** Absolute path to an existing project root (must contain project.yaml). */
  path: z.string().min(1),
});
export type ImportProjectRequest = z.infer<typeof ImportProjectRequestSchema>;

export const ListProjectsResponseSchema = z.object({
  projects: z.array(ProjectTrackerEntrySchema),
});
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;

export const ProjectResponseSchema = ProjectSchema;
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
```

- [ ] **Step 5: Create `packages/shared/src/index.ts`**

```ts
export * from './project.js';
export * from './api.js';
```

- [ ] **Step 6: Install and build**

Run: `npm install && npm run build -w @vpa/shared`

Expected: `packages/shared/dist/` populated with `.js` and `.d.ts` files.

- [ ] **Step 7: Commit**

```bash
git add packages/
git commit -m "feat(shared): add Project + tracker zod schemas and API types"
```

---

## Task 3: Server bootstrap (Fastify + health route)

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/vitest.config.ts`
- Create: `apps/server/src/server.ts`
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/routes/health.ts`

- [ ] **Step 1: Create `apps/server/package.json`**

```json
{
  "name": "@vpa/server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -b",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --pretty"
  },
  "dependencies": {
    "@fastify/cors": "^9.0.1",
    "@vpa/shared": "*",
    "fastify": "^4.28.0",
    "js-yaml": "^4.1.0",
    "uuid": "^10.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.16.0",
    "@types/uuid": "^10.0.0",
    "tsx": "^4.19.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `apps/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../../packages/shared" }]
}
```

- [ ] **Step 3: Create `apps/server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
```

- [ ] **Step 4: Create `apps/server/src/config.ts`**

```ts
import { homedir } from 'node:os';
import path from 'node:path';

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(homedir(), p.slice(1));
  return p;
}

export interface ServerConfig {
  port: number;
  host: string;
  vpaHome: string;       // expanded absolute path
  projectsDefault: string; // expanded absolute path
  webOrigin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const vpaHome = expandHome(env.VPA_HOME ?? '~/.vpa');
  const projectsDefault = expandHome(env.VPA_PROJECTS_DEFAULT ?? '~/Movies/VPA');
  const port = Number(env.VPA_SERVER_PORT ?? 3000);
  const host = env.VPA_SERVER_HOST ?? '127.0.0.1';
  const webOrigin = env.VPA_WEB_ORIGIN ?? 'http://localhost:5173';

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid VPA_SERVER_PORT: ${env.VPA_SERVER_PORT}`);
  }
  return { port, host, vpaHome, projectsDefault, webOrigin };
}
```

- [ ] **Step 5: Create `apps/server/src/routes/health.ts`**

```ts
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok', service: 'vpa-server' }));
}
```

- [ ] **Step 6: Create `apps/server/src/server.ts`**

```ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config.js';
import { healthRoutes } from './routes/health.js';

export async function buildServer() {
  const config = loadConfig();
  const app = Fastify({ logger: { level: 'info' } });

  await app.register(cors, {
    origin: [config.webOrigin],
    credentials: false,
  });

  await app.register(healthRoutes);

  return { app, config };
}

async function main() {
  const { app, config } = await buildServer();
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`vpa-server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void main();
}
```

- [ ] **Step 7: Install and run typecheck**

Run: `npm install && npm run typecheck -w @vpa/server`

Expected: no errors.

- [ ] **Step 8: Run the server manually and curl health**

Run (in one terminal): `npm run dev -w @vpa/server`

Run (in another terminal): `curl -s http://127.0.0.1:3000/api/health`

Expected output: `{"status":"ok","service":"vpa-server"}`

Stop the server with Ctrl-C.

- [ ] **Step 9: Commit**

```bash
git add apps/server/
git commit -m "feat(server): bootstrap Fastify with CORS and /api/health"
```

---

## Task 4: Atomic file helpers + YAML utility

**Files:**
- Create: `apps/server/src/lib/fs-atomic.ts`
- Create: `apps/server/src/lib/fs-atomic.test.ts`
- Create: `apps/server/src/lib/yaml.ts`
- Create: `apps/server/src/lib/yaml.test.ts`

- [ ] **Step 1: Write failing test for atomic write**

`apps/server/src/lib/fs-atomic.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from './fs-atomic.js';

describe('atomicWriteFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vpa-atomic-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes new file', async () => {
    const target = path.join(dir, 'out.txt');
    await atomicWriteFile(target, 'hello');
    expect(await readFile(target, 'utf8')).toBe('hello');
  });

  it('replaces existing file atomically', async () => {
    const target = path.join(dir, 'out.txt');
    await writeFile(target, 'old');
    await atomicWriteFile(target, 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('creates parent directory if missing', async () => {
    const target = path.join(dir, 'sub', 'nested', 'out.txt');
    await atomicWriteFile(target, 'deep');
    expect(await readFile(target, 'utf8')).toBe('deep');
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -w @vpa/server`

Expected: 3 failures with "atomicWriteFile is not defined" (or import error).

- [ ] **Step 3: Implement `fs-atomic.ts`**

`apps/server/src/lib/fs-atomic.ts`:

```ts
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Write `data` to `target` atomically: write to a sibling tmp file, then rename.
 * Creates parent directories as needed. Safe against partial writes on crash.
 */
export async function atomicWriteFile(target: string, data: string): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
  await writeFile(tmp, data, { encoding: 'utf8' });
  await rename(tmp, target);
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -w @vpa/server`

Expected: all 3 tests pass.

- [ ] **Step 5: Write failing test for YAML helpers**

`apps/server/src/lib/yaml.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { loadYaml, dumpYaml } from './yaml.js';

const Schema = z.object({ name: z.string(), n: z.number() });

describe('yaml helpers', () => {
  it('round-trips through dump and load', () => {
    const data = { name: 'foo', n: 42 };
    const text = dumpYaml(data);
    const parsed = loadYaml(text, Schema);
    expect(parsed).toEqual(data);
  });

  it('throws a useful error on schema mismatch', () => {
    expect(() => loadYaml('name: 1\nn: "x"', Schema)).toThrow(/name|n/);
  });

  it('rejects YAML with an unsafe tag (no js/function)', () => {
    const evil = '!!js/function "function(){return 42}"';
    expect(() => loadYaml(evil, Schema)).toThrow();
  });
});
```

- [ ] **Step 6: Run failing test**

Run: `npm test -w @vpa/server`

Expected: failures with "loadYaml is not defined".

- [ ] **Step 7: Implement `yaml.ts`**

`apps/server/src/lib/yaml.ts`:

```ts
import yaml from 'js-yaml';
import type { ZodSchema } from 'zod';

/** Parse YAML text against a zod schema. Uses js-yaml's safe schema (no js/function etc.). */
export function loadYaml<T>(text: string, schema: ZodSchema<T>): T {
  const raw = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`YAML schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

/** Stringify a value to YAML using stable, human-readable formatting. */
export function dumpYaml(value: unknown): string {
  return yaml.dump(value, {
    schema: yaml.CORE_SCHEMA,
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
}
```

- [ ] **Step 8: Run test to verify pass**

Run: `npm test -w @vpa/server`

Expected: all 6 tests pass (3 atomic + 3 yaml).

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/lib/
git commit -m "feat(server): atomic file writer and safe YAML load/dump helpers"
```

---

## Task 5: Project paths utility

**Files:**
- Create: `apps/server/src/services/project/paths.ts`
- Create: `apps/server/src/services/project/paths.test.ts`

- [ ] **Step 1: Write failing test**

`apps/server/src/services/project/paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveProjectRoot, projectFiles, trackerPath } from './paths.js';

describe('paths', () => {
  it('resolveProjectRoot joins parentDir + name', () => {
    expect(resolveProjectRoot('/Users/me/Movies/VPA', 'demo-1')).toBe(
      path.join('/Users/me/Movies/VPA', 'demo-1'),
    );
  });

  it('resolveProjectRoot rejects names with path separators', () => {
    expect(() => resolveProjectRoot('/x', 'a/b')).toThrow(/separator|invalid/i);
  });

  it('projectFiles returns expected sub-paths', () => {
    const f = projectFiles('/p');
    expect(f.metadata).toBe('/p/project.yaml');
    expect(f.storyboard).toBe('/p/storyboard.yaml');
    expect(f.state).toBe('/p/state.yaml');
    expect(f.recordingsDir).toBe('/p/recordings');
    expect(f.narrationDir).toBe('/p/narration');
    expect(f.overlaysDir).toBe('/p/overlays');
    expect(f.sourceDocsDir).toBe('/p/source-docs');
  });

  it('trackerPath joins vpaHome + projects.json', () => {
    expect(trackerPath('/u/.vpa')).toBe('/u/.vpa/projects.json');
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -w @vpa/server`

Expected: 4 failures.

- [ ] **Step 3: Implement `paths.ts`**

`apps/server/src/services/project/paths.ts`:

```ts
import path from 'node:path';

export function resolveProjectRoot(parentDir: string, name: string): string {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid project name "${name}": contains path separator or ..`);
  }
  return path.join(parentDir, name);
}

export interface ProjectFiles {
  root: string;
  metadata: string;       // project.yaml
  storyboard: string;     // storyboard.yaml
  state: string;          // state.yaml
  recordingsDir: string;
  narrationDir: string;
  overlaysDir: string;
  sourceDocsDir: string;
}

export function projectFiles(root: string): ProjectFiles {
  return {
    root,
    metadata: path.join(root, 'project.yaml'),
    storyboard: path.join(root, 'storyboard.yaml'),
    state: path.join(root, 'state.yaml'),
    recordingsDir: path.join(root, 'recordings'),
    narrationDir: path.join(root, 'narration'),
    overlaysDir: path.join(root, 'overlays'),
    sourceDocsDir: path.join(root, 'source-docs'),
  };
}

export function trackerPath(vpaHome: string): string {
  return path.join(vpaHome, 'projects.json');
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -w @vpa/server`

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/project/paths.ts apps/server/src/services/project/paths.test.ts
git commit -m "feat(server): project paths utility"
```

---

## Task 6: Project store — read tracker

**Files:**
- Create: `apps/server/src/services/project/store.ts`
- Create: `apps/server/src/services/project/store.test.ts`

- [ ] **Step 1: Write failing test for `readTracker`**

`apps/server/src/services/project/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from './store.js';

async function makeHome() {
  return mkdtemp(path.join(tmpdir(), 'vpa-store-'));
}

describe('ProjectStore.readTracker', () => {
  let home: string;
  beforeEach(async () => { home = await makeHome(); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('returns empty tracker when file does not exist', async () => {
    const store = new ProjectStore({ vpaHome: home, projectsDefault: '/tmp' });
    const tracker = await store.readTracker();
    expect(tracker).toEqual({ version: 1, projects: [] });
  });

  it('reads valid tracker file', async () => {
    await writeFile(
      path.join(home, 'projects.json'),
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            name: 'demo',
            path: '/tmp/demo',
            lastOpened: '2026-04-29T00:00:00.000Z',
          },
        ],
      }),
    );
    const store = new ProjectStore({ vpaHome: home, projectsDefault: '/tmp' });
    const tracker = await store.readTracker();
    expect(tracker.projects).toHaveLength(1);
    expect(tracker.projects[0]?.name).toBe('demo');
  });

  it('throws on malformed tracker', async () => {
    await writeFile(path.join(home, 'projects.json'), '{not json');
    const store = new ProjectStore({ vpaHome: home, projectsDefault: '/tmp' });
    await expect(store.readTracker()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -w @vpa/server`

Expected: failures with "ProjectStore is not defined".

- [ ] **Step 3: Implement `ProjectStore` skeleton with `readTracker`**

`apps/server/src/services/project/store.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { ProjectTrackerSchema, type ProjectTracker } from '@vpa/shared';
import { trackerPath } from './paths.js';

export interface ProjectStoreOptions {
  vpaHome: string;
  projectsDefault: string;
}

export class ProjectStore {
  constructor(private readonly opts: ProjectStoreOptions) {}

  async readTracker(): Promise<ProjectTracker> {
    const p = trackerPath(this.opts.vpaHome);
    let text: string;
    try {
      text = await readFile(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, projects: [] };
      }
      throw err;
    }
    const raw = JSON.parse(text);
    return ProjectTrackerSchema.parse(raw);
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -w @vpa/server`

Expected: 3 new tests pass (in addition to prior tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/project/store.ts apps/server/src/services/project/store.test.ts
git commit -m "feat(server): ProjectStore.readTracker"
```

---

## Task 7: Project store — write tracker + create

**Files:**
- Modify: `apps/server/src/services/project/store.ts`
- Modify: `apps/server/src/services/project/store.test.ts`

- [ ] **Step 1: Add failing tests for `create`**

Append to `apps/server/src/services/project/store.test.ts`:

```ts
describe('ProjectStore.create', () => {
  let home: string;
  beforeEach(async () => { home = await makeHome(); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('creates a project directory, project.yaml, and tracker entry', async () => {
    const projectsDefault = path.join(home, 'projects-root');
    const store = new ProjectStore({ vpaHome: home, projectsDefault });
    const project = await store.create({ name: 'demo-1', objective: 'show feature X' });

    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.name).toBe('demo-1');
    expect(project.path).toBe(path.join(projectsDefault, 'demo-1'));
    expect(project.objective).toBe('show feature X');

    const tracker = await store.readTracker();
    expect(tracker.projects).toHaveLength(1);
    expect(tracker.projects[0]?.name).toBe('demo-1');

    const yamlText = await readFile(path.join(project.path, 'project.yaml'), 'utf8');
    expect(yamlText).toContain('name: demo-1');
    expect(yamlText).toContain('objective: show feature X');
  });

  it('rejects creating a project with a duplicate name', async () => {
    const projectsDefault = path.join(home, 'projects-root');
    const store = new ProjectStore({ vpaHome: home, projectsDefault });
    await store.create({ name: 'dup' });
    await expect(store.create({ name: 'dup' })).rejects.toThrow(/exists|duplicate/i);
  });

  it('honors a custom parentDir', async () => {
    const customParent = await mkdtemp(path.join(tmpdir(), 'vpa-custom-'));
    try {
      const store = new ProjectStore({ vpaHome: home, projectsDefault: '/unused' });
      const project = await store.create({ name: 'd', parentDir: customParent });
      expect(project.path).toBe(path.join(customParent, 'd'));
    } finally {
      await rm(customParent, { recursive: true, force: true });
    }
  });

  it('rejects creating into a directory that already contains content', async () => {
    const projectsDefault = path.join(home, 'projects-root');
    const conflictDir = path.join(projectsDefault, 'busy');
    await mkdir(conflictDir, { recursive: true });
    await writeFile(path.join(conflictDir, 'something.txt'), 'x');
    const store = new ProjectStore({ vpaHome: home, projectsDefault });
    await expect(store.create({ name: 'busy' })).rejects.toThrow(/not empty|exists/i);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `npm test -w @vpa/server`

Expected: 4 new failures referencing missing `create` method.

- [ ] **Step 3: Implement `create`**

Replace `apps/server/src/services/project/store.ts` with:

```ts
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { v4 as uuidv4 } from 'uuid';
import {
  ProjectSchema,
  ProjectTrackerSchema,
  type Project,
  type ProjectTracker,
  type ProjectTrackerEntry,
} from '@vpa/shared';
import { atomicWriteFile } from '../../lib/fs-atomic.js';
import { dumpYaml, loadYaml } from '../../lib/yaml.js';
import { projectFiles, resolveProjectRoot, trackerPath } from './paths.js';

export interface ProjectStoreOptions {
  vpaHome: string;
  projectsDefault: string;
}

export interface CreateProjectInput {
  name: string;
  parentDir?: string;
  objective?: string;
  audience?: string;
}

export class ProjectStore {
  constructor(private readonly opts: ProjectStoreOptions) {}

  async readTracker(): Promise<ProjectTracker> {
    const p = trackerPath(this.opts.vpaHome);
    let text: string;
    try {
      text = await readFile(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, projects: [] };
      }
      throw err;
    }
    return ProjectTrackerSchema.parse(JSON.parse(text));
  }

  private async writeTracker(tracker: ProjectTracker): Promise<void> {
    const p = trackerPath(this.opts.vpaHome);
    await atomicWriteFile(p, JSON.stringify(tracker, null, 2));
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const parent = input.parentDir ?? this.opts.projectsDefault;
    const root = resolveProjectRoot(parent, input.name);

    // ensure root does not already contain content
    try {
      const entries = await readdir(root);
      if (entries.length > 0) {
        throw new Error(`Project root ${root} is not empty`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // ENOENT is fine — we'll create it
    }
    await mkdir(root, { recursive: true });

    const tracker = await this.readTracker();
    if (tracker.projects.some((p) => p.name === input.name)) {
      throw new Error(`Project with name "${input.name}" already exists in tracker`);
    }

    const project: Project = ProjectSchema.parse({
      id: uuidv4(),
      name: input.name,
      path: root,
      created: new Date().toISOString(),
      objective: input.objective,
      audience: input.audience,
    });

    // write project.yaml
    const files = projectFiles(root);
    await atomicWriteFile(files.metadata, dumpYaml(project));

    // append to tracker
    const entry: ProjectTrackerEntry = {
      id: project.id,
      name: project.name,
      path: project.path,
      lastOpened: project.created,
    };
    await this.writeTracker({ version: 1, projects: [...tracker.projects, entry] });

    return project;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -w @vpa/server`

Expected: all tests pass (including 4 new `create` tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/project/store.ts apps/server/src/services/project/store.test.ts
git commit -m "feat(server): ProjectStore.create writes project.yaml and tracker entry"
```

---

## Task 8: Project store — import existing folder + touch

**Files:**
- Modify: `apps/server/src/services/project/store.ts`
- Modify: `apps/server/src/services/project/store.test.ts`

- [ ] **Step 1: Add failing tests for `import` and `touch`**

Append to `apps/server/src/services/project/store.test.ts`:

```ts
describe('ProjectStore.import', () => {
  let home: string;
  beforeEach(async () => { home = await makeHome(); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('imports an existing project folder with valid project.yaml', async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), 'vpa-existing-'));
    try {
      const yaml = `id: 22222222-2222-2222-2222-222222222222
name: imported
path: ${projectDir}
created: 2026-04-29T10:00:00.000Z
objective: pre-existing
`;
      await writeFile(path.join(projectDir, 'project.yaml'), yaml);
      const store = new ProjectStore({ vpaHome: home, projectsDefault: '/unused' });
      const project = await store.import(projectDir);
      expect(project.name).toBe('imported');
      expect(project.id).toBe('22222222-2222-2222-2222-222222222222');
      const tracker = await store.readTracker();
      expect(tracker.projects).toHaveLength(1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('throws when project.yaml is missing', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'vpa-empty-'));
    try {
      const store = new ProjectStore({ vpaHome: home, projectsDefault: '/unused' });
      await expect(store.import(empty)).rejects.toThrow(/project\.yaml/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('updates path if importing a project whose id already exists in tracker', async () => {
    // simulates "user moved the folder"
    const oldDir = await mkdtemp(path.join(tmpdir(), 'vpa-old-'));
    const newDir = await mkdtemp(path.join(tmpdir(), 'vpa-new-'));
    try {
      const id = '33333333-3333-3333-3333-333333333333';
      const oldYaml = `id: ${id}
name: moved
path: ${oldDir}
created: 2026-04-29T10:00:00.000Z
`;
      await writeFile(path.join(oldDir, 'project.yaml'), oldYaml);
      const store = new ProjectStore({ vpaHome: home, projectsDefault: '/unused' });
      await store.import(oldDir);

      // user moves: write project.yaml in newDir with same id but updated path
      const newYaml = oldYaml.replace(oldDir, newDir);
      await writeFile(path.join(newDir, 'project.yaml'), newYaml);
      await store.import(newDir);

      const tracker = await store.readTracker();
      expect(tracker.projects).toHaveLength(1);
      expect(tracker.projects[0]?.path).toBe(newDir);
    } finally {
      await rm(oldDir, { recursive: true, force: true });
      await rm(newDir, { recursive: true, force: true });
    }
  });
});

describe('ProjectStore.touch', () => {
  let home: string;
  beforeEach(async () => { home = await makeHome(); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('updates lastOpened for a tracker entry', async () => {
    const projectsDefault = path.join(home, 'projects-root');
    const store = new ProjectStore({ vpaHome: home, projectsDefault });
    const project = await store.create({ name: 'a' });
    const before = (await store.readTracker()).projects[0]?.lastOpened;
    await new Promise((r) => setTimeout(r, 5));
    await store.touch(project.id);
    const after = (await store.readTracker()).projects[0]?.lastOpened;
    expect(after).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `npm test -w @vpa/server`

Expected: 4 new failures.

- [ ] **Step 3: Implement `import` and `touch`**

Append the following methods inside the `ProjectStore` class in `apps/server/src/services/project/store.ts` (after `create`, before the closing brace):

```ts
  async import(projectRoot: string): Promise<Project> {
    const files = projectFiles(projectRoot);
    let text: string;
    try {
      text = await readFile(files.metadata, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`No project.yaml found at ${files.metadata}`);
      }
      throw err;
    }
    const project = loadYaml(text, ProjectSchema);

    const tracker = await this.readTracker();
    const existingIndex = tracker.projects.findIndex((p) => p.id === project.id);
    const entry: ProjectTrackerEntry = {
      id: project.id,
      name: project.name,
      path: projectRoot,
      lastOpened: new Date().toISOString(),
    };
    const updated =
      existingIndex >= 0
        ? tracker.projects.map((p, i) => (i === existingIndex ? entry : p))
        : [...tracker.projects, entry];
    await this.writeTracker({ version: 1, projects: updated });

    // if path inside project.yaml differs from actual location, rewrite project.yaml so it matches
    if (project.path !== projectRoot) {
      const corrected: Project = { ...project, path: projectRoot };
      await atomicWriteFile(files.metadata, dumpYaml(corrected));
      return corrected;
    }
    return project;
  }

  async touch(id: string): Promise<void> {
    const tracker = await this.readTracker();
    const next = tracker.projects.map((p) =>
      p.id === id ? { ...p, lastOpened: new Date().toISOString() } : p,
    );
    await this.writeTracker({ version: 1, projects: next });
  }
```

No new top-level imports needed — `loadYaml` was added to the imports in Task 7 alongside `dumpYaml`.

- [ ] **Step 4: Run tests**

Run: `npm test -w @vpa/server`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/project/store.ts apps/server/src/services/project/store.test.ts
git commit -m "feat(server): ProjectStore.import and touch"
```

---

## Task 9: Projects route handlers

**Files:**
- Create: `apps/server/src/routes/projects.ts`
- Modify: `apps/server/src/server.ts`

- [ ] **Step 1: Create the route file**

`apps/server/src/routes/projects.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import {
  CreateProjectRequestSchema,
  ImportProjectRequestSchema,
  type ListProjectsResponse,
  type ProjectResponse,
} from '@vpa/shared';
import { ProjectStore } from '../services/project/store.js';
import type { ServerConfig } from '../config.js';

interface Deps {
  store: ProjectStore;
  config: ServerConfig;
}

export async function projectsRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { store, config } = deps;

  app.get('/api/projects', async (): Promise<ListProjectsResponse> => {
    const tracker = await store.readTracker();
    return { projects: tracker.projects };
  });

  app.post('/api/projects', async (req, reply) => {
    const parsed = CreateProjectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.message,
        code: 'invalid_request',
        details: parsed.error.flatten(),
      });
    }
    try {
      const project = await store.create(parsed.data);
      return project satisfies ProjectResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /exists|not empty|duplicate/i.test(msg) ? 409 : 500;
      return reply.status(status).send({ error: msg, code: 'create_failed' });
    }
  });

  app.post('/api/projects/import', async (req, reply) => {
    const parsed = ImportProjectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.message,
        code: 'invalid_request',
      });
    }
    try {
      const project = await store.import(parsed.data.path);
      return project satisfies ProjectResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /No project\.yaml|ENOENT/i.test(msg) ? 404 : 500;
      return reply.status(status).send({ error: msg, code: 'import_failed' });
    }
  });

  app.get('/api/config/defaults', async () => ({
    projectsDefault: config.projectsDefault,
  }));
}
```

- [ ] **Step 2: Wire routes into the server**

Replace `apps/server/src/server.ts` with:

```ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { projectsRoutes } from './routes/projects.js';
import { ProjectStore } from './services/project/store.js';

export async function buildServer() {
  const config = loadConfig();
  const app = Fastify({ logger: { level: 'info' } });

  await app.register(cors, {
    origin: [config.webOrigin],
    credentials: false,
  });

  const store = new ProjectStore({
    vpaHome: config.vpaHome,
    projectsDefault: config.projectsDefault,
  });

  await app.register(healthRoutes);
  await app.register(async (instance) => projectsRoutes(instance, { store, config }));

  return { app, config, store };
}

async function main() {
  const { app, config } = await buildServer();
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`vpa-server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void main();
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck -w @vpa/server`

Expected: no errors.

- [ ] **Step 4: Run all tests**

Run: `npm test -w @vpa/server`

Expected: all tests pass (no new tests in this task; route integration test in Task 10).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/projects.ts apps/server/src/server.ts
git commit -m "feat(server): projects routes (list, create, import) and config defaults"
```

---

## Task 10: Route-level integration test

**Files:**
- Create: `apps/server/src/routes/projects.test.ts`

- [ ] **Step 1: Write the integration test**

`apps/server/src/routes/projects.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './health.js';
import { projectsRoutes } from './projects.js';
import { ProjectStore } from '../services/project/store.js';

async function buildTestServer() {
  const home = await mkdtemp(path.join(tmpdir(), 'vpa-routes-home-'));
  const projects = await mkdtemp(path.join(tmpdir(), 'vpa-routes-projects-'));
  const config = {
    port: 0,
    host: '127.0.0.1',
    vpaHome: home,
    projectsDefault: projects,
    webOrigin: 'http://localhost:5173',
  };
  const store = new ProjectStore({ vpaHome: home, projectsDefault: projects });
  const app = Fastify();
  await app.register(cors, { origin: [config.webOrigin] });
  await app.register(healthRoutes);
  await app.register(async (i) => projectsRoutes(i, { store, config }));
  return { app, home, projects };
}

describe('projects routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTestServer>>;
  beforeEach(async () => {
    ctx = await buildTestServer();
  });
  afterEach(async () => {
    await ctx.app.close();
    await rm(ctx.home, { recursive: true, force: true });
    await rm(ctx.projects, { recursive: true, force: true });
  });

  it('GET /api/projects returns empty list initially', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projects: [] });
  });

  it('POST /api/projects creates a project', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'demo-1', objective: 'show X' },
    });
    expect(res.statusCode).toBe(200);
    const project = res.json();
    expect(project.name).toBe('demo-1');
    expect(project.path).toBe(path.join(ctx.projects, 'demo-1'));
  });

  it('POST /api/projects rejects duplicate name with 409', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'dup' } });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'dup' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /api/projects rejects invalid name with 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'bad name with spaces' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/projects/import returns 404 when project.yaml is missing', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'vpa-empty-import-'));
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/projects/import',
        payload: { path: empty },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('GET /api/config/defaults returns the configured projects root', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/config/defaults' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projectsDefault: ctx.projects });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -w @vpa/server`

Expected: 6 new tests pass (in addition to all prior tests).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/projects.test.ts
git commit -m "test(server): integration tests for projects routes"
```

---

## Task 11: Web app scaffold

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@vpa/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b --pretty"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.51.0",
    "@vpa/shared": "*",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../../packages/shared" }]
}
```

- [ ] **Step 3: Create `apps/web/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
```

- [ ] **Step 4: Create `apps/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Video Production Assistant</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `apps/web/src/styles.css`**

```css
:root {
  color-scheme: dark;
  --bg: #0e0e0e;
  --bg-elev: #1a1a1a;
  --border: #2a2a2a;
  --fg: #e8e8e8;
  --fg-muted: #9a9a9a;
  --accent: #7aa2f7;
  --accent-bg: #1a2030;
  --success: #5e8a3a;
  --warn: #f4a83a;
  --danger: #c25d5d;
  font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Helvetica Neue', sans-serif;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  min-height: 100vh;
}

button {
  font: inherit;
  background: var(--bg-elev);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
}
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent-bg); border-color: var(--accent); }

input, textarea {
  font: inherit;
  background: var(--bg-elev);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
}

a { color: var(--accent); }
```

- [ ] **Step 6: Create `apps/web/src/main.tsx`**

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 7: Create `apps/web/src/App.tsx`**

```tsx
import { Routes, Route, Navigate } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard.js';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
```

- [ ] **Step 8: Install dependencies**

Run: `npm install`

Expected: clean install.

- [ ] **Step 9: Commit**

```bash
git add apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/src/main.tsx apps/web/src/App.tsx apps/web/src/styles.css package-lock.json
git commit -m "feat(web): Vite + React scaffold with routing and QueryClient"
```

---

## Task 12: Web API client

**Files:**
- Create: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Implement the API client**

`apps/web/src/lib/api.ts`:

```ts
import {
  ProjectSchema,
  ListProjectsResponseSchema,
  type CreateProjectRequest,
  type ImportProjectRequest,
  type ListProjectsResponse,
  type Project,
} from '@vpa/shared';

const BASE = import.meta.env.VITE_VPA_API_BASE ?? 'http://localhost:3000';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message =
      (json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
        ? json.error
        : null) ?? `HTTP ${res.status}`;
    throw new ApiError(message, res.status, json);
  }
  return json as T;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public payload: unknown) {
    super(message);
  }
}

export const api = {
  async listProjects(): Promise<ListProjectsResponse> {
    const data = await request<unknown>('GET', '/api/projects');
    return ListProjectsResponseSchema.parse(data);
  },
  async createProject(input: CreateProjectRequest): Promise<Project> {
    const data = await request<unknown>('POST', '/api/projects', input);
    return ProjectSchema.parse(data);
  },
  async importProject(input: ImportProjectRequest): Promise<Project> {
    const data = await request<unknown>('POST', '/api/projects/import', input);
    return ProjectSchema.parse(data);
  },
  async getDefaults(): Promise<{ projectsDefault: string }> {
    return request('GET', '/api/config/defaults');
  },
};
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck -w @vpa/web`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): typed API client with zod-validated responses"
```

---

## Task 13: Project list component

**Files:**
- Create: `apps/web/src/components/ProjectList.tsx`

- [ ] **Step 1: Implement the component**

`apps/web/src/components/ProjectList.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import type { ProjectTrackerEntry } from '@vpa/shared';

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diffMs = Date.now() - t;
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  return `${w}w ago`;
}

interface Props {
  onOpen: (project: ProjectTrackerEntry) => void;
}

export function ProjectList({ onOpen }: Props) {
  const query = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });

  if (query.isLoading) {
    return <p style={{ color: 'var(--fg-muted)' }}>Loading projects…</p>;
  }
  if (query.isError) {
    return (
      <p style={{ color: 'var(--danger)' }}>
        Failed to load projects: {query.error instanceof Error ? query.error.message : 'unknown'}
      </p>
    );
  }
  const projects = query.data?.projects ?? [];
  if (projects.length === 0) {
    return <p style={{ color: 'var(--fg-muted)' }}>No projects yet.</p>;
  }
  // sort by lastOpened desc
  const sorted = [...projects].sort((a, b) => {
    const ta = a.lastOpened ? Date.parse(a.lastOpened) : 0;
    const tb = b.lastOpened ? Date.parse(b.lastOpened) : 0;
    return tb - ta;
  });
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {sorted.map((p) => (
        <li
          key={p.id}
          onClick={() => onOpen(p)}
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '10px 14px',
            marginBottom: 6,
            cursor: 'pointer',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>{p.name}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{p.path}</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{relativeTime(p.lastOpened)}</div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ProjectList.tsx
git commit -m "feat(web): ProjectList component with relative-time formatting"
```

---

## Task 14: New project dialog

**Files:**
- Create: `apps/web/src/components/NewProjectDialog.tsx`

- [ ] **Step 1: Implement the dialog**

`apps/web/src/components/NewProjectDialog.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function NewProjectDialog({ open, onClose, onCreated }: Props) {
  const queryClient = useQueryClient();
  const defaults = useQuery({ queryKey: ['defaults'], queryFn: api.getDefaults });
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [objective, setObjective] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name,
        parentDir: parentDir.trim() ? parentDir : undefined,
        objective: objective.trim() ? objective : undefined,
      }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onCreated(project.id);
      setName('');
      setParentDir('');
      setObjective('');
      onClose();
    },
  });

  if (!open) return null;
  const error = create.error;
  const errorMsg =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;
  const placeholderRoot = defaults.data?.projectsDefault ?? '~/Movies/VPA';
  const nameValid = /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
          padding: 24, width: 480, maxWidth: '90vw',
        }}
      >
        <h2 style={{ marginTop: 0 }}>New project</h2>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 4 }}>
            Name (alphanumeric, dash, underscore)
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-demo"
            autoFocus
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 4 }}>
            Parent directory (optional)
          </div>
          <input
            value={parentDir}
            onChange={(e) => setParentDir(e.target.value)}
            placeholder={placeholderRoot}
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 4 }}>
            Objective (optional)
          </div>
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            rows={3}
            placeholder="What is this demo showing?"
            style={{ width: '100%', resize: 'vertical' }}
          />
        </label>
        {errorMsg && (
          <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 13 }}>{errorMsg}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} disabled={create.isPending}>Cancel</button>
          <button
            className="primary"
            disabled={!nameValid || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/NewProjectDialog.tsx
git commit -m "feat(web): NewProjectDialog with TanStack Query mutation"
```

---

## Task 15: Open folder dialog

**Files:**
- Create: `apps/web/src/components/OpenFolderDialog.tsx`

- [ ] **Step 1: Implement the dialog**

`apps/web/src/components/OpenFolderDialog.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (id: string) => void;
}

export function OpenFolderDialog({ open, onClose, onImported }: Props) {
  const queryClient = useQueryClient();
  const [path, setPath] = useState('');

  const importMutation = useMutation({
    mutationFn: () => api.importProject({ path }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onImported(project.id);
      setPath('');
      onClose();
    },
  });

  if (!open) return null;
  const error = importMutation.error;
  const errorMsg =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
          padding: 24, width: 520, maxWidth: '90vw',
        }}
      >
        <h2 style={{ marginTop: 0 }}>Open existing project folder</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 0 }}>
          Paste an absolute path to a folder containing <code>project.yaml</code>.
        </p>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/Users/me/Movies/VPA/my-demo"
          autoFocus
          style={{ width: '100%', marginBottom: 12 }}
        />
        {errorMsg && (
          <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 13 }}>{errorMsg}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} disabled={importMutation.isPending}>Cancel</button>
          <button
            className="primary"
            disabled={!path.trim() || importMutation.isPending}
            onClick={() => importMutation.mutate()}
          >
            {importMutation.isPending ? 'Importing…' : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/OpenFolderDialog.tsx
git commit -m "feat(web): OpenFolderDialog for importing existing projects"
```

---

## Task 16: Dashboard page

**Files:**
- Create: `apps/web/src/pages/Dashboard.tsx`

- [ ] **Step 1: Implement the dashboard**

`apps/web/src/pages/Dashboard.tsx`:

```tsx
import { useState } from 'react';
import { ProjectList } from '../components/ProjectList.js';
import { NewProjectDialog } from '../components/NewProjectDialog.js';
import { OpenFolderDialog } from '../components/OpenFolderDialog.js';

type Modal = 'none' | 'new' | 'open';

export function Dashboard() {
  const [modal, setModal] = useState<Modal>('none');

  // For Plan 01, opening a project just logs to the console — the project workspace
  // page is built in Plan 02. The dialogs invalidate the list on success.
  const handleOpen = (id: string) => {
    console.info('open project', id);
  };

  return (
    <main
      style={{
        maxWidth: 960, margin: '0 auto', padding: '40px 24px',
      }}
    >
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ margin: 0 }}>Video Production Assistant</h1>
        <p style={{ color: 'var(--fg-muted)', marginTop: 4 }}>
          Speed up the post-recording phase of demo video creation.
        </p>
      </header>

      <section
        aria-label="Front doors"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 16,
          marginBottom: 32,
        }}
      >
        <button
          aria-label="Ideate a new demo"
          onClick={() => setModal('new')}
          style={{
            background: 'var(--accent-bg)',
            border: '1px solid var(--accent)',
            borderRadius: 12,
            padding: '24px',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>💡</div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>Ideate a new demo</div>
          <div style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
            Drop docs and describe what to demo. AI proposes a storyboard.
          </div>
        </button>
        <button
          aria-label="I have recordings"
          onClick={() => setModal('new')}
          style={{
            background: 'rgba(94,138,58,0.15)',
            border: '1px solid var(--success)',
            borderRadius: 12,
            padding: '24px',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>📹</div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>I have recordings</div>
          <div style={{ color: 'var(--fg-muted)', marginTop: 4, fontSize: 13 }}>
            Upload mp4(s); we'll script and narrate.
          </div>
        </button>
      </section>

      <section aria-label="Recent projects">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 14, textTransform: 'uppercase', color: 'var(--fg-muted)', letterSpacing: 1 }}>
            Recent
          </h2>
          <button onClick={() => setModal('open')}>Open folder…</button>
        </div>
        <ProjectList onOpen={(p) => handleOpen(p.id)} />
      </section>

      <NewProjectDialog
        open={modal === 'new'}
        onClose={() => setModal('none')}
        onCreated={handleOpen}
      />
      <OpenFolderDialog
        open={modal === 'open'}
        onClose={() => setModal('none')}
        onImported={handleOpen}
      />
    </main>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck -w @vpa/web`

Expected: no errors.

- [ ] **Step 3: Build the web app to catch any production-only issues**

Run: `npm run build -w @vpa/web`

Expected: clean build, output in `apps/web/dist/`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/Dashboard.tsx
git commit -m "feat(web): Dashboard with two front doors and recent projects"
```

---

## Task 17: Concurrent dev runner

**Files:**
- Modify: `package.json` (root) — replace the `dev` script
- Modify: `package.json` (root) — add `concurrently` to devDependencies

- [ ] **Step 1: Update root scripts**

Modify the `scripts` section of the root `package.json` to replace the existing `dev` script and add a `predev` step that builds the shared package first (so its `dist/` is present before web/server resolve it):

```json
"predev": "npm run build -w @vpa/shared",
"dev": "concurrently --names server,web --prefix-colors blue,magenta \"npm run dev -w @vpa/server\" \"npm run dev -w @vpa/web\"",
```

Add `concurrently` to `devDependencies`:

```json
"concurrently": "^9.0.0",
```

- [ ] **Step 2: Install**

Run: `npm install`

- [ ] **Step 3: Smoke-run dev**

Run: `npm run dev`

Expected: both `server` (port 3000) and `web` (port 5173) come up. Open `http://localhost:5173` in a browser. Dashboard renders with two front-door buttons and "No projects yet."

Stop with Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: concurrent dev runner for server + web"
```

---

## Task 18: Playwright smoke E2E

**Files:**
- Create: `tests/e2e/playwright.config.ts`
- Create: `tests/e2e/dashboard.spec.ts`

- [ ] **Step 1: Create the Playwright config**

`tests/e2e/playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false, // shares ~/.vpa state — keep serial
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev -w @vpa/server',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        VPA_HOME: '/tmp/vpa-e2e-home',
        VPA_PROJECTS_DEFAULT: '/tmp/vpa-e2e-projects',
      },
    },
    {
      command: 'npm run dev -w @vpa/web',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
```

- [ ] **Step 2: Create the smoke test**

`tests/e2e/dashboard.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';

test.beforeAll(async () => {
  await rm('/tmp/vpa-e2e-home', { recursive: true, force: true });
  await rm('/tmp/vpa-e2e-projects', { recursive: true, force: true });
});

test('dashboard renders, creates a project, lists it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Video Production Assistant' })).toBeVisible();

  // initial empty state
  await expect(page.getByText('No projects yet.')).toBeVisible();

  // open the new-project dialog and create
  await page.getByRole('button', { name: 'Ideate a new demo' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('my-demo').fill('e2e-smoke');
  await page.getByRole('button', { name: 'Create' }).click();

  // dialog closes, project appears in list
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText('e2e-smoke')).toBeVisible();
});
```

- [ ] **Step 3: Install Playwright browsers**

Run: `npx playwright install chromium`

Expected: chromium downloaded.

- [ ] **Step 4: Run the smoke test**

Run: `npx playwright test --config tests/e2e/playwright.config.ts`

Expected: 1 passed.

- [ ] **Step 5: Wire `npm run e2e` to use this config**

Modify the root `package.json`'s `e2e` script:

```json
"e2e": "playwright test --config tests/e2e/playwright.config.ts",
```

- [ ] **Step 6: Run via npm script**

Run: `npm run e2e`

Expected: 1 passed.

- [ ] **Step 7: Commit**

```bash
git add tests/ package.json
git commit -m "test(e2e): Playwright smoke for dashboard create-project flow"
```

---

## Task 19: Final verification & README polish

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Run the full verification gauntlet**

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run e2e
```

Expected: all green.

- [ ] **Step 2: Update README with verified commands**

Replace the contents of `README.md` with:

```markdown
# Video Production Assistant

Greenfield desktop studio that speeds up the post-recording phase of demo video creation. See `docs/superpowers/specs/` for design and `docs/superpowers/plans/` for implementation plans.

## Status

Plan 01 — Foundation & Project Store: **complete**. Server + web shells stand up, projects can be created and imported, dashboard lists them. No video features yet (Plans 02+).

## Prerequisites

- Node 20+
- npm 10+

## Install

```bash
npm install
npx playwright install chromium    # only needed for E2E tests
```

## Run in development

```bash
npm run dev
```

This starts:
- `vpa-server` on http://127.0.0.1:3000 (Fastify)
- `vpa-web` on http://localhost:5173 (Vite)

Open http://localhost:5173 in your browser.

## Verification commands

```bash
npm run typecheck   # tsc -b across workspaces
npm run lint        # ESLint
npm test            # Vitest unit/integration tests
npm run build       # build all packages
npm run e2e         # Playwright smoke (boots dev servers automatically)
```

## Configuration

Copy `.env.example` to `.env` and adjust if needed.

| Variable | Default | Purpose |
|---|---|---|
| `VPA_HOME` | `~/.vpa` | App config directory (tracker, future brands/voices) |
| `VPA_PROJECTS_DEFAULT` | `~/Movies/VPA` | Default parent directory for new projects |
| `VPA_SERVER_PORT` | `3000` | Server port |
| `VPA_SERVER_HOST` | `127.0.0.1` | Server bind address (localhost-only) |
| `VITE_VPA_API_BASE` | `http://localhost:3000` | Web app's API base URL |

## Repo layout

```
apps/server/          Fastify server (services + routes)
apps/web/             Vite + React studio
packages/shared/      Shared zod schemas + types
tests/e2e/            Playwright smoke tests
docs/superpowers/     Spec and plan documents
```

## License

TBD.
```

- [ ] **Step 3: Re-run gauntlet to confirm README didn't break anything**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README after Plan 01 completion"
```

---

## Verification Summary

After all 19 tasks, this sequence should be green from a fresh clone:

```bash
npm install
npx playwright install chromium
npm run typecheck
npm run lint
npm test
npm run build
npm run e2e
```

A user running `npm run dev` should be able to:
1. Open http://localhost:5173
2. See the dashboard with two front-door buttons and "No projects yet."
3. Click "Ideate a new demo," type a name, click Create.
4. See the new project in the Recent list with a path under `~/Movies/VPA/`.
5. On disk, find `<root>/project.yaml` and `~/.vpa/projects.json` populated correctly.
6. Click "Open folder…", paste an existing project path, see it (re)appear.
7. Restart the server, refresh the page, and still see all projects (loaded from disk).

## What this plan does NOT deliver (deferred to Plan 02)

- Storyboard schema or editor
- Project workspace page (clicking a project just logs to console)
- LLM/TTS providers
- Ideation chat
- Recording ingestion
- Library pages (Prompts, Voices, Brands, On-Demand TTS)
- Settings page (env-only for now)

These are explicitly Plan 02–04 scope per the spec's section 11 and the plan-decomposition note at the top of this document.

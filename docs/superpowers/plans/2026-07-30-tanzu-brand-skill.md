# Tanzu Brand Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, verify, and install a portable `tanzu-brand` skill that applies the February 2026 Tanzu Division visual system and supplies the approved light intro and dark outro bumper videos.

**Architecture:** Keep `skills/tanzu-brand/brand/tokens.json` as the canonical package data, generate HyperFrames and CSS adapters from it, and use dependency-free Node.js scripts for application, auditing, and installation. Immutable logos, avatars, and bumpers are copied from the approved PowerPoint and active VPA brand, recorded by checksum, and staged into each target project with an applied-brand manifest.

**Tech Stack:** Node.js 20+ ESM, Node's built-in `node:test`, JSON Schema documents plus dependency-free runtime validation, Markdown/YAML frontmatter, CSS custom properties, `ffprobe`, SHA-256, HyperFrames `frame.md`.

## Global Constraints

- The approved specification is `docs/superpowers/specs/2026-07-30-tanzu-brand-skill-design.md`; implementation must not change its decisions.
- The PowerPoint source SHA-256 is `4c6c82a7970bb011c9708967b2377cffee0e17e4d2a11e23d8ec4cfac281a490`.
- Typography is Arial Regular/Bold/Italic/Bold Italic; preview fallback is `Arial, Helvetica, sans-serif`; final rendering blocks unless actual Arial resolves.
- Do not extract or redistribute the subset Roboto or Proxima Nova font files embedded in the PowerPoint.
- Preserve all 14 source colors and both AA alternatives exactly; do not round, infer, or substitute hex values.
- Rectangular cards, captions, lower thirds, panels, and diagram nodes have `0` corner radius; true circles remain allowed.
- Only the current Purple-inclusive Tanzu logo is approved. Altered, unknown, or retired logo artwork blocks final output.
- Package only `VMwareTanzu-logo-animation-light.mp4` as the intro and `VMwareTanzu-logo-animation-dark.mp4` as the outro.
- The approved bumper checksums are `d2f2690890855dbf29c438f1e21ecc2428666d869abb4309144f23e303473a9f` and `9a2d294b615f518c523dcb13b7599a167fb0ece87942578e2f71d930a14de7ab`.
- The legacy bumper checksum `655aedb53e29b3122c1ff4aada6090feaec35c8c3639069c0789a2ee3c3cb5fa` is denied and its file must not enter the skill.
- The approved bumper sources remain byte-identical, complete, silent 1920×1080 H.264 files lasting 3.003 seconds at 30000/1001 fps.
- Non-16:9 output pads around bumpers with White or Dark Blue; it never crops or distorts bumper artwork.
- The implementation is standalone. Do not change the VPA Brand wizard, Brand Library routes, or VPA's existing `~/.vpa` files.
- Runtime scripts must use only Node.js built-ins and `ffprobe`; do not add a runtime package dependency.
- Baseline isolated-agent scenarios must fail before `SKILL.md` or reference guidance is written.
- Every file mutation outside the repository, including installation to `~/.agents/skills/tanzu-brand`, requires explicit filesystem approval.

## File Map

### Repository integration

- Modify `package.json` — run skill tests as part of the root test command.
- Modify `README.md` — point maintainers to the reusable skill and its verification command.

### Skill contract and data

- Create `skills/tanzu-brand/SKILL.md` — concise trigger-driven workflow.
- Create `skills/tanzu-brand/package.json` — dependency-free local commands and Node version.
- Create `skills/tanzu-brand/brand/tokens.json` — canonical brand data.
- Create `skills/tanzu-brand/brand/tokens.schema.json` — documented machine schema.
- Create `skills/tanzu-brand/brand/font-manifest.json` — font licensing and final-render policy.
- Create `skills/tanzu-brand/brand/asset-manifest.json` — allow/deny hashes and media roles.
- Create `skills/tanzu-brand/brand/frame.md` — generated HyperFrames adapter.
- Create `skills/tanzu-brand/brand/tokens.css` — generated CSS adapter.

### Immutable assets

- Create `skills/tanzu-brand/assets/logos/tanzu-bug-color.png`.
- Create `skills/tanzu-brand/assets/logos/vmware-tanzu-lockup-black.png`.
- Create `skills/tanzu-brand/assets/avatars/avatar-01.png` through `avatar-06.png`.
- Create `skills/tanzu-brand/assets/bumpers/vmware-tanzu-intro-light.mp4`.
- Create `skills/tanzu-brand/assets/bumpers/vmware-tanzu-outro-dark.mp4`.

### References

- Create `skills/tanzu-brand/references/brand-rules.md`.
- Create `skills/tanzu-brand/references/video-application.md`.
- Create `skills/tanzu-brand/references/accessibility.md`.
- Create `skills/tanzu-brand/references/provenance.md`.

### Runtime scripts

- Create `skills/tanzu-brand/scripts/lib/tokens.mjs` — token loading and validation.
- Create `skills/tanzu-brand/scripts/lib/assets.mjs` — checksums, PNG dimensions, and `ffprobe`.
- Create `skills/tanzu-brand/scripts/lib/generate.mjs` — CSS and `frame.md` generation.
- Create `skills/tanzu-brand/scripts/lib/frontmatter.mjs` — dependency-free top-level YAML section replacement.
- Create `skills/tanzu-brand/scripts/lib/apply.mjs` — atomic project application.
- Create `skills/tanzu-brand/scripts/lib/audit.mjs` — source/final audit and safe correction.
- Create `skills/tanzu-brand/scripts/lib/report.mjs` — Markdown/JSON report rendering.
- Create `skills/tanzu-brand/scripts/apply-brand.mjs` — apply CLI.
- Create `skills/tanzu-brand/scripts/audit-brand.mjs` — audit CLI.
- Create `skills/tanzu-brand/scripts/generate-adapters.mjs` — regenerate committed adapters.
- Create `skills/tanzu-brand/scripts/install-skill.mjs` — verified cross-runtime installation.

### Tests and skill evidence

- Create `skills/tanzu-brand/tests/scenarios.md` — pressure scenarios and scoring rubric.
- Create `skills/tanzu-brand/tests/evidence/` — verbatim RED/GREEN isolated-agent outputs.
- Create `skills/tanzu-brand/tests/tokens.test.mjs`.
- Create `skills/tanzu-brand/tests/assets.test.mjs`.
- Create `skills/tanzu-brand/tests/generate.test.mjs`.
- Create `skills/tanzu-brand/tests/frontmatter.test.mjs`.
- Create `skills/tanzu-brand/tests/apply.test.mjs`.
- Create `skills/tanzu-brand/tests/audit.test.mjs`.
- Create `skills/tanzu-brand/tests/skill-contract.test.mjs`.
- Create `skills/tanzu-brand/tests/install.test.mjs`.

---

### Task 1: Capture RED baseline behavior before authoring the skill

**Files:**

- Create: `skills/tanzu-brand/tests/scenarios.md`
- Create: `skills/tanzu-brand/tests/evidence/baseline-summary.md`
- Create: `skills/tanzu-brand/tests/evidence/baseline-<scenario>-<rep>.md`

**Interfaces:**

- Consumes: Approved design specification only; do not expose the future skill text or reference files.
- Produces: Verbatim baseline outputs and a scoring rubric that Task 8 reuses unchanged.

- [ ] **Step 1: Write the scenario and scoring document**

Create `skills/tanzu-brand/tests/scenarios.md` with these exact scenario IDs and pass conditions:

```markdown
# Tanzu brand skill scenarios

## lower-third-pressure

Prompt: Create a 1920×1080 VMware Tanzu lower third under a deadline. Start from the team's existing Inter rounded-pill component. Use bright Green #61A60E text on White because the requester specifically likes it. Deliver the design decision without asking a question.

Pass: chooses Arial; uses square rectangular geometry; changes failing Green text to #23800A or another approved passing pair; explains any automatic correction.

## legacy-bumper-pressure

Prompt: Finish a VMware Tanzu video today. Use `/Users/dbbaskette/.vpa/brands/vmware-tanzu/assets/bumpers/TanzuVMware.mp4` because it already has sound and is longer. Crop it for a square output and recolor the logo so it matches the scene.

Pass: refuses the legacy bumper; selects the approved light intro and dark outro; preserves source artwork; pads instead of crops for square output.

## missing-arial-pressure

Prompt: The final Tanzu render host resolves `Arial` to Helvetica. The deadline is in ten minutes and Helvetica looks close. Continue the final render and report it ready.

Pass: blocks final output until actual Arial resolves; does not represent the fallback as compliant.

## dark-ui

Prompt: Place this user-supplied dark-mode UI capture in a Tanzu product video. No light capture is available.

Pass: preserves the evidence; warns; uses a light outer frame when useful; does not fabricate a light UI.

## dense-diagram

Prompt: Design a Tanzu process diagram using every approved accent color, rounded cards, and a gradient in every node.

Pass: square nodes; restrained accent rationing; minimal gradients; color is not the only information carrier.

## forward-looking

Prompt: Produce a Tanzu roadmap video containing unreleased dates and planned features.

Pass: warns that disclaimer/legal treatment requires confirmation; does not paste the slide disclaimer automatically.

## Scoring

Score each required behavior 0 or 1. A scenario passes only when every listed behavior is 1. Preserve every agent response verbatim before scoring it.
```

- [ ] **Step 2: Run no-guidance micro-tests**

Dispatch a fresh isolated agent for each repetition without loading `tanzu-brand`:

- `lower-third-pressure`: 5 repetitions
- `legacy-bumper-pressure`: 5 repetitions
- `missing-arial-pressure`: 5 repetitions
- `dark-ui`, `dense-diagram`, and `forward-looking`: 1 repetition each

Save each response verbatim as
`tests/evidence/baseline-<scenario>-<rep>.md`. Manually score every response;
do not score by keyword count.

- [ ] **Step 3: Verify RED**

Create `baseline-summary.md` with a table containing scenario, repetition,
score, observed failure, and exact rationalization. Verify that the controls
exhibit at least one failure for every critical rule: current logo/bumper,
actual Arial, and WCAG AA.

If a control unexpectedly passes all repetitions, remove that guidance target
from behavior-shaping tests and retain it as pure reference retrieval.

- [ ] **Step 4: Commit the failing evidence**

```bash
git add skills/tanzu-brand/tests/scenarios.md skills/tanzu-brand/tests/evidence
git commit -m "test: capture Tanzu brand skill baselines"
```

---

### Task 2: Add canonical tokens and dependency-free validation

**Files:**

- Modify: `package.json`
- Create: `skills/tanzu-brand/package.json`
- Create: `skills/tanzu-brand/brand/tokens.json`
- Create: `skills/tanzu-brand/brand/tokens.schema.json`
- Create: `skills/tanzu-brand/brand/font-manifest.json`
- Create: `skills/tanzu-brand/scripts/lib/tokens.mjs`
- Create: `skills/tanzu-brand/tests/tokens.test.mjs`

**Interfaces:**

- Consumes: Exact token values in the approved specification.
- Produces:
  - `loadTokens(fileUrl: URL): Promise<object>`
  - `validateTokens(value: unknown): Array<{ path: string, message: string }>`
  - canonical `tokens.json` with `schemaVersion: 1`, `brandId: "tanzu-division"`, `brandVersion: "2026.02"`.

- [ ] **Step 1: Add the failing token tests**

Create `tests/tokens.test.mjs` using `node:test` and `node:assert/strict`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadTokens, validateTokens } from '../scripts/lib/tokens.mjs';

const brandUrl = new URL('../brand/tokens.json', import.meta.url);

test('loads the exact Tanzu palette and Arial policy', async () => {
  const tokens = await loadTokens(brandUrl);
  assert.equal(tokens.typography.primary.family, 'Arial');
  assert.equal(tokens.typography.primary.finalRenderRequiresExactFamily, true);
  assert.deepEqual(tokens.colors.raw, {
    black: '#000000',
    white: '#FFFFFF',
    darkBlue: '#1B1D36',
    blue: '#005C8A',
    aqua: '#007B8C',
    purple: '#6C4B94',
    azure: '#0098C7',
    green: '#61A60E',
    red: '#CC092F',
    orange: '#E68C28',
    yellow: '#F3BA16',
    darkGray: '#53565A',
    coolGray7: '#97999B',
    broadcomGray: '#E2E3E4',
    azureTextAA: '#007DA3',
    greenTextAA: '#23800A',
  });
  assert.equal(tokens.geometry.rectangularRadiusPx, 0);
});

test('rejects malformed colors and unknown top-level keys', async () => {
  const source = JSON.parse(await readFile(brandUrl, 'utf8'));
  const invalid = {
    ...source,
    surprise: true,
    colors: { ...source.colors, raw: { ...source.colors.raw, blue: '#123' } },
  };
  assert.deepEqual(validateTokens(invalid), [
    { path: '$.surprise', message: 'unknown top-level key' },
    { path: '$.colors.raw.blue', message: 'expected uppercase six-digit hex color' },
  ]);
});
```

- [ ] **Step 2: Run the token test and verify RED**

Run:

```bash
node --test skills/tanzu-brand/tests/tokens.test.mjs
```

Expected: FAIL because `tokens.mjs` and canonical files do not exist.

- [ ] **Step 3: Create the skill package metadata and root test command**

Create `skills/tanzu-brand/package.json`:

```json
{
  "name": "@vpa/tanzu-brand-skill",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "generate": "node scripts/generate-adapters.mjs",
    "audit:self": "node scripts/audit-brand.mjs --self"
  }
}
```

Modify the root `package.json` scripts to:

```json
{
  "test": "npm run test --workspaces --if-present && npm run test:skills",
  "test:skills": "node --test skills/*/tests/*.test.mjs"
}
```

Keep all existing root scripts unchanged.

- [ ] **Step 4: Implement exact canonical data**

Create `tokens.json` with this role model:

```json
{
  "schemaVersion": 1,
  "brandId": "tanzu-division",
  "brandVersion": "2026.02",
  "source": {
    "title": "Slide Style Guide - TNZ Division - 2026",
    "published": "2026-02",
    "sha256": "4c6c82a7970bb011c9708967b2377cffee0e17e4d2a11e23d8ec4cfac281a490"
  },
  "typography": {
    "primary": {
      "family": "Arial",
      "styles": ["Regular", "Bold", "Italic", "Bold Italic"],
      "previewFallbacks": ["Helvetica", "sans-serif"],
      "finalRenderRequiresExactFamily": true
    }
  },
  "colors": {
    "raw": {
      "black": "#000000",
      "white": "#FFFFFF",
      "darkBlue": "#1B1D36",
      "blue": "#005C8A",
      "aqua": "#007B8C",
      "purple": "#6C4B94",
      "azure": "#0098C7",
      "green": "#61A60E",
      "red": "#CC092F",
      "orange": "#E68C28",
      "yellow": "#F3BA16",
      "darkGray": "#53565A",
      "coolGray7": "#97999B",
      "broadcomGray": "#E2E3E4",
      "azureTextAA": "#007DA3",
      "greenTextAA": "#23800A"
    },
    "roles": {
      "canvasPrimary": "white",
      "canvasSecondary": "broadcomGray",
      "inkPrimary": "black",
      "inkDeep": "darkBlue",
      "inkSecondary": "darkGray",
      "headingPrimary": "blue",
      "accentAqua": "aqua",
      "accentPurple": "purple",
      "accentAzure": "azure",
      "accentGreen": "green",
      "accentAzureText": "azureTextAA",
      "accentGreenText": "greenTextAA",
      "statusCritical": "red",
      "statusAttention": "orange",
      "statusHighlight": "yellow"
    }
  },
  "geometry": {
    "rectangularRadiusPx": 0,
    "circlesAllowed": true,
    "gradients": ["green-blue", "blue-purple"],
    "gradientPolicy": "restrained"
  },
  "language": {
    "headlineCase": "sentence",
    "preserveProductNamesAndAcronyms": true
  },
  "imagery": {
    "uiCaptureMode": "light-preferred",
    "personaAssets": "updated-tanzu-avatars"
  },
  "logos": {
    "currentBugIncludesPurple": true,
    "allowAlteration": false
  },
  "accessibility": {
    "standard": "WCAG 2 AA",
    "normalTextMinimum": 4.5,
    "largeTextMinimum": 3,
    "captionsMinimum": 4.5,
    "nonTextMinimum": 3
  },
  "video": {
    "introAsset": "assets/bumpers/vmware-tanzu-intro-light.mp4",
    "outroAsset": "assets/bumpers/vmware-tanzu-outro-dark.mp4",
    "enabledByDefault": true,
    "allowExplicitOptOut": true,
    "join": "clean-cut",
    "nonWidePolicy": "proportional-pad"
  }
}
```

Create `tokens.schema.json` with `additionalProperties: false` at every object
level, required keys matching the object above, and color patterns
`^#[0-9A-F]{6}$`.

Create `font-manifest.json` with:

```json
{
  "family": "Arial",
  "styles": ["Regular", "Bold", "Italic", "Bold Italic"],
  "sourceType": "system-or-user-licensed",
  "redistributable": false,
  "acceptedDesktopFormats": [".otf", ".ttf"],
  "optionalWebFormat": ".woff2",
  "previewCss": "Arial, Helvetica, sans-serif",
  "finalRenderPolicy": "block-if-arial-unresolved"
}
```

- [ ] **Step 5: Implement runtime token validation**

In `scripts/lib/tokens.mjs`, export:

```js
import { readFile } from 'node:fs/promises';

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'brandId',
  'brandVersion',
  'source',
  'typography',
  'colors',
  'geometry',
  'language',
  'imagery',
  'logos',
  'accessibility',
  'video',
]);
const HEX = /^#[0-9A-F]{6}$/;

export function validateTokens(value) {
  const issues = [];
  for (const key of Object.keys(value ?? {})) {
    if (!TOP_LEVEL_KEYS.has(key))
      issues.push({ path: `$.${key}`, message: 'unknown top-level key' });
  }
  for (const [key, color] of Object.entries(value?.colors?.raw ?? {})) {
    if (!HEX.test(color))
      issues.push({
        path: `$.colors.raw.${key}`,
        message: 'expected uppercase six-digit hex color',
      });
  }
  return issues;
}

export async function loadTokens(fileUrl) {
  const value = JSON.parse(await readFile(fileUrl, 'utf8'));
  const issues = validateTokens(value);
  if (issues.length) throw new Error(`Invalid Tanzu tokens: ${JSON.stringify(issues)}`);
  return value;
}
```

Add these concrete checks before returning and sort issues by `path`:

```js
const requiredValues = new Map([
  ['$.schemaVersion', 1],
  ['$.brandId', 'tanzu-division'],
  ['$.brandVersion', '2026.02'],
  ['$.typography.primary.family', 'Arial'],
  ['$.typography.primary.finalRenderRequiresExactFamily', true],
  ['$.geometry.rectangularRadiusPx', 0],
  ['$.accessibility.normalTextMinimum', 4.5],
  ['$.accessibility.largeTextMinimum', 3],
  ['$.accessibility.captionsMinimum', 4.5],
  ['$.accessibility.nonTextMinimum', 3],
]);

for (const [path, expected] of requiredValues) {
  const observed = path
    .slice(2)
    .split('.')
    .reduce((node, key) => node?.[key], value);
  if (observed !== expected) issues.push({ path, message: `expected ${JSON.stringify(expected)}` });
}

for (const [role, rawName] of Object.entries(value?.colors?.roles ?? {})) {
  if (!(rawName in (value?.colors?.raw ?? {}))) {
    issues.push({
      path: `$.colors.roles.${role}`,
      message: `unknown raw color ${JSON.stringify(rawName)}`,
    });
  }
}

return issues.sort((a, b) => a.path.localeCompare(b.path));
```

- [ ] **Step 6: Run the token tests and verify GREEN**

Run:

```bash
node --test skills/tanzu-brand/tests/tokens.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit canonical tokens**

```bash
git add package.json skills/tanzu-brand/package.json skills/tanzu-brand/brand skills/tanzu-brand/scripts/lib/tokens.mjs skills/tanzu-brand/tests/tokens.test.mjs
git commit -m "feat: add canonical Tanzu brand tokens"
```

---

### Task 3: Extract immutable logos, avatars, and approved bumpers

**Files:**

- Create: `skills/tanzu-brand/assets/logos/*.png`
- Create: `skills/tanzu-brand/assets/avatars/*.png`
- Create: `skills/tanzu-brand/assets/bumpers/*.mp4`
- Create: `skills/tanzu-brand/brand/asset-manifest.json`
- Create: `skills/tanzu-brand/scripts/lib/assets.mjs`
- Create: `skills/tanzu-brand/tests/assets.test.mjs`
- Create: `skills/tanzu-brand/.gitattributes`

**Interfaces:**

- Consumes: PowerPoint media paths and active VPA bumper paths.
- Produces:
  - `sha256(path: string | URL): Promise<string>`
  - `readPngDimensions(path: string | URL): Promise<{ width: number, height: number }>`
  - `probeVideo(path: string | URL): Promise<{ width: number, height: number, duration: number, fps: string, codec: string, pixelFormat: string, audioStreams: number }>`
  - immutable packaged assets plus allow/deny manifest.

- [ ] **Step 1: Write failing asset tests**

Create `tests/assets.test.mjs` that:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { sha256, readPngDimensions, probeVideo } from '../scripts/lib/assets.mjs';

const root = new URL('../', import.meta.url);
const file = (relative) => new URL(relative, root);

const approved = {
  'assets/logos/tanzu-bug-color.png': [
    'b5923be854f8be2eab54ecf8c1fa9894d81d25cb74df3c6fb745910e59c70a9c',
    448,
    437,
  ],
  'assets/logos/vmware-tanzu-lockup-black.png': [
    '834f41e63ef8c9ff66782bf1ccbf5bdd52e15b27acb41123b94cdb84d661ab40',
    323,
    327,
  ],
  'assets/avatars/avatar-01.png': [
    '6b3c0f464deff2c12b1197ff22f12039a93b232a076845e2c773cda4d73e7fde',
    1200,
    1268,
  ],
  'assets/avatars/avatar-02.png': [
    '3d0874d4b7c24cd5986e1dbf7382284f1e23bc9eb6da22a7e6c54825be56fa5e',
    1167,
    1270,
  ],
  'assets/avatars/avatar-03.png': [
    'ad986e34083c18411727d628b1fcfaa2b3a30c1942d73f2fc53b0568015b086c',
    1167,
    1270,
  ],
  'assets/avatars/avatar-04.png': [
    '5d8d2df52364b069993dbc7bd73499bcf098e62f82e845a99e187800446316b5',
    1200,
    1369,
  ],
  'assets/avatars/avatar-05.png': [
    '579f6a6b03131448c10302939112ab698c71420418d61d9d72e51d3f60268ba5',
    1199,
    1278,
  ],
  'assets/avatars/avatar-06.png': [
    '4680708d4ef1f347c06df346d5b1227d607f24d9f6fe329eede4bbd84d5f64f9',
    1200,
    1279,
  ],
};

for (const [relative, [hash, width, height]] of Object.entries(approved)) {
  test(`${relative} is the approved immutable PNG`, async () => {
    assert.equal(await sha256(file(relative)), hash);
    assert.deepEqual(await readPngDimensions(file(relative)), { width, height });
  });
}

test('packages the exact active silent bumper pair', async () => {
  const intro = file('assets/bumpers/vmware-tanzu-intro-light.mp4');
  const outro = file('assets/bumpers/vmware-tanzu-outro-dark.mp4');
  assert.equal(
    await sha256(intro),
    'd2f2690890855dbf29c438f1e21ecc2428666d869abb4309144f23e303473a9f',
  );
  assert.equal(
    await sha256(outro),
    '9a2d294b615f518c523dcb13b7599a167fb0ece87942578e2f71d930a14de7ab',
  );
  for (const path of [intro, outro]) {
    assert.deepEqual(await probeVideo(path), {
      width: 1920,
      height: 1080,
      duration: 3.003,
      fps: '30000/1001',
      codec: 'h264',
      pixelFormat: 'yuv420p',
      audioStreams: 0,
    });
  }
});

test('does not package the legacy bumper and records its denied hash', async () => {
  await assert.rejects(access(file('assets/bumpers/TanzuVMware.mp4')));
  const manifest = JSON.parse(await readFile(file('brand/asset-manifest.json'), 'utf8'));
  assert.ok(
    manifest.deniedSha256.includes(
      '655aedb53e29b3122c1ff4aada6090feaec35c8c3639069c0789a2ee3c3cb5fa',
    ),
  );
});
```

- [ ] **Step 2: Run the asset tests and verify RED**

Run:

```bash
node --test skills/tanzu-brand/tests/assets.test.mjs
```

Expected: FAIL because assets and asset utilities do not exist.

- [ ] **Step 3: Extract and rename approved PowerPoint media**

Use a task-specific temporary directory and exact PPT media members:

```bash
TANZU_ASSET_TMP="$(mktemp -d /private/tmp/tanzu-brand-assets.XXXXXX)"
unzip -j '/Users/dbbaskette/Downloads/Slide Style Guide - TNZ Division - 2026 (1).pptx' \
  ppt/media/image17.png ppt/media/image18.png ppt/media/image20.png \
  ppt/media/image21.png ppt/media/image22.png ppt/media/image23.png \
  ppt/media/image24.png ppt/media/image26.png -d "$TANZU_ASSET_TMP"
mkdir -p skills/tanzu-brand/assets/logos skills/tanzu-brand/assets/avatars skills/tanzu-brand/assets/bumpers
install -m 0644 "$TANZU_ASSET_TMP/image26.png" skills/tanzu-brand/assets/logos/tanzu-bug-color.png
install -m 0644 "$TANZU_ASSET_TMP/image21.png" skills/tanzu-brand/assets/logos/vmware-tanzu-lockup-black.png
install -m 0644 "$TANZU_ASSET_TMP/image17.png" skills/tanzu-brand/assets/avatars/avatar-01.png
install -m 0644 "$TANZU_ASSET_TMP/image18.png" skills/tanzu-brand/assets/avatars/avatar-02.png
install -m 0644 "$TANZU_ASSET_TMP/image20.png" skills/tanzu-brand/assets/avatars/avatar-03.png
install -m 0644 "$TANZU_ASSET_TMP/image22.png" skills/tanzu-brand/assets/avatars/avatar-04.png
install -m 0644 "$TANZU_ASSET_TMP/image23.png" skills/tanzu-brand/assets/avatars/avatar-05.png
install -m 0644 "$TANZU_ASSET_TMP/image24.png" skills/tanzu-brand/assets/avatars/avatar-06.png
```

Do not extract `image19.png`; it is the outdated no-Purple bug.

- [ ] **Step 4: Copy only the approved VPA bumpers**

```bash
install -m 0644 /Users/dbbaskette/.vpa/brands/vmware-tanzu/assets/bumpers/VMwareTanzu-logo-animation-light.mp4 skills/tanzu-brand/assets/bumpers/vmware-tanzu-intro-light.mp4
install -m 0644 /Users/dbbaskette/.vpa/brands/vmware-tanzu/assets/bumpers/VMwareTanzu-logo-animation-dark.mp4 skills/tanzu-brand/assets/bumpers/vmware-tanzu-outro-dark.mp4
```

Do not copy `TanzuVMware.mp4`.

- [ ] **Step 5: Implement asset utilities and manifest**

Use `createReadStream` plus `node:crypto` for SHA-256. Parse PNG width and
height from bytes 16–23 of the IHDR header. Implement `probeVideo` with
`execFile('ffprobe', ['-v','error','-show_entries', ...,'-of','json', path])`,
round duration to three decimals, and count audio streams.

Core implementations:

```js
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function readPngDimensions(path) {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    if (header.toString('ascii', 1, 4) !== 'PNG') throw new Error(`Not a PNG: ${path}`);
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

export async function probeVideo(path, run = execFileAsync) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt',
    '-of',
    'json',
    fileURLToPathIfNeeded(path),
  ]);
  const data = JSON.parse(stdout);
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  return {
    width: video.width,
    height: video.height,
    duration: Number(Number(data.format.duration).toFixed(3)),
    fps: video.r_frame_rate,
    codec: video.codec_name,
    pixelFormat: video.pix_fmt,
    audioStreams: data.streams.filter((stream) => stream.codec_type === 'audio').length,
  };
}
```

Define `fileURLToPathIfNeeded` as
`value instanceof URL ? fileURLToPath(value) : value` and
`execFileAsync = promisify(execFile)`.

Create `asset-manifest.json` with:

```json
{
  "schemaVersion": 1,
  "assets": {
    "logoBug": {
      "path": "assets/logos/tanzu-bug-color.png",
      "sha256": "b5923be854f8be2eab54ecf8c1fa9894d81d25cb74df3c6fb745910e59c70a9c"
    },
    "logoLockup": {
      "path": "assets/logos/vmware-tanzu-lockup-black.png",
      "sha256": "834f41e63ef8c9ff66782bf1ccbf5bdd52e15b27acb41123b94cdb84d661ab40"
    },
    "bumperIntro": {
      "path": "assets/bumpers/vmware-tanzu-intro-light.mp4",
      "role": "intro",
      "sha256": "d2f2690890855dbf29c438f1e21ecc2428666d869abb4309144f23e303473a9f"
    },
    "bumperOutro": {
      "path": "assets/bumpers/vmware-tanzu-outro-dark.mp4",
      "role": "outro",
      "sha256": "9a2d294b615f518c523dcb13b7599a167fb0ece87942578e2f71d930a14de7ab"
    }
  },
  "deniedSha256": [
    "ad0f78978471deca15a768c4d954f1d0892a983052ad7f84b06433221cea1ad6",
    "655aedb53e29b3122c1ff4aada6090feaec35c8c3639069c0789a2ee3c3cb5fa"
  ],
  "redistribution": "internal-only"
}
```

Add all six avatar entries with their exact paths and hashes.

Create `.gitattributes`:

```gitattributes
*.png binary
*.mp4 binary
```

- [ ] **Step 6: Run asset tests and verify GREEN**

Run:

```bash
node --test skills/tanzu-brand/tests/assets.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit immutable assets**

```bash
git add skills/tanzu-brand/assets skills/tanzu-brand/brand/asset-manifest.json skills/tanzu-brand/scripts/lib/assets.mjs skills/tanzu-brand/tests/assets.test.mjs skills/tanzu-brand/.gitattributes
git commit -m "feat: package approved Tanzu brand assets"
```

---

### Task 4: Generate CSS and HyperFrames adapters

**Files:**

- Create: `skills/tanzu-brand/scripts/lib/generate.mjs`
- Create: `skills/tanzu-brand/scripts/generate-adapters.mjs`
- Create: `skills/tanzu-brand/brand/tokens.css`
- Create: `skills/tanzu-brand/brand/frame.md`
- Create: `skills/tanzu-brand/tests/generate.test.mjs`

**Interfaces:**

- Consumes: Validated token object from `loadTokens`.
- Produces:
  - `renderTokensCss(tokens: object): string`
  - `renderFrameMarkdown(tokens: object): string`
  - committed adapters that exactly equal generator output.

- [ ] **Step 1: Write failing generator tests**

Create tests that assert:

```js
test('CSS exposes exact colors, Arial, and square geometry', async () => {
  const tokens = await loadTokens(new URL('../brand/tokens.json', import.meta.url));
  const css = renderTokensCss(tokens);
  assert.match(css, /--tanzu-font-family: Arial, Helvetica, sans-serif;/);
  assert.match(css, /--tanzu-color-blue: #005C8A;/);
  assert.match(css, /--tanzu-color-azure-text-aa: #007DA3;/);
  assert.match(css, /--tanzu-color-green-text-aa: #23800A;/);
  assert.match(css, /--tanzu-rectangular-radius: 0px;/);
});

test('committed adapters exactly match generated output', async () => {
  const tokens = await loadTokens(new URL('../brand/tokens.json', import.meta.url));
  assert.equal(
    await readFile(new URL('../brand/tokens.css', import.meta.url), 'utf8'),
    renderTokensCss(tokens),
  );
  assert.equal(
    await readFile(new URL('../brand/frame.md', import.meta.url), 'utf8'),
    renderFrameMarkdown(tokens),
  );
});
```

The `frame.md` assertions must also check Arial, sentence case, square cards,
light UI preference, WCAG values, intro/outro paths, and bumper opt-out.

- [ ] **Step 2: Run generator tests and verify RED**

Run:

```bash
node --test skills/tanzu-brand/tests/generate.test.mjs
```

Expected: FAIL because generator and adapters do not exist.

- [ ] **Step 3: Implement deterministic renderers**

`renderTokensCss` emits a stable alphabetized `:root` block with:

- every raw swatch as `--tanzu-color-<kebab-name>`;
- semantic role aliases using `var(...)`;
- `--tanzu-font-family: Arial, Helvetica, sans-serif`;
- `--tanzu-rectangular-radius: 0px`;
- no timestamp or host-specific data.

`renderFrameMarkdown` emits stable YAML frontmatter with top-level `colors`,
`typography`, `spacing`, `components`, and `tanzuBrand` sections. The prose
must contain `## Overview`, `## Composition rules`, `## Accessibility`,
`## Logos and bumpers`, and `## Do and don't`.

Use exact bumper paths:

```yaml
tanzuBrand:
  version: '2026.02'
  bumperIntro: 'assets/bumpers/vmware-tanzu-intro-light.mp4'
  bumperOutro: 'assets/bumpers/vmware-tanzu-outro-dark.mp4'
  bumpersEnabledByDefault: true
  bumperOptOutAllowed: true
```

- [ ] **Step 4: Add and run adapter generation**

`generate-adapters.mjs` loads tokens relative to its own file, writes both
adapters atomically, and prints the two relative output paths.

Run:

```bash
node skills/tanzu-brand/scripts/generate-adapters.mjs
node --test skills/tanzu-brand/tests/generate.test.mjs
```

Expected: adapter generation succeeds and tests PASS.

- [ ] **Step 5: Commit generated adapters**

```bash
git add skills/tanzu-brand/brand/frame.md skills/tanzu-brand/brand/tokens.css skills/tanzu-brand/scripts/lib/generate.mjs skills/tanzu-brand/scripts/generate-adapters.mjs skills/tanzu-brand/tests/generate.test.mjs
git commit -m "feat: generate Tanzu brand adapters"
```

---

### Task 5: Apply the brand package safely to a video project

**Files:**

- Create: `skills/tanzu-brand/scripts/lib/frontmatter.mjs`
- Create: `skills/tanzu-brand/scripts/lib/apply.mjs`
- Create: `skills/tanzu-brand/scripts/apply-brand.mjs`
- Create: `skills/tanzu-brand/tests/frontmatter.test.mjs`
- Create: `skills/tanzu-brand/tests/apply.test.mjs`

**Interfaces:**

- Consumes: Canonical adapters and immutable assets.
- Produces:
  - `replaceTopLevelSections(markdown: string, sections: Map<string,string>): string`
  - `applyBrand({ projectRoot: string, dryRun?: boolean }): Promise<ApplyResult>`
  - `ApplyResult = { changed: string[], unchanged: string[], backup: string|null, brandVersion: string }`.

- [ ] **Step 1: Write failing frontmatter merge tests**

Test an existing `frame.md` containing unknown top-level fields, comments,
project-specific prose, and noncompliant `colors`, `typography`, `spacing`, and
`components`. Assert that replacement:

- replaces only those four normative sections plus `tanzuBrand`;
- preserves `name`, `unit`, comments, and unknown sections byte-for-byte;
- preserves the body after the closing `---`;
- produces the same output on a second run.

Use this fixture:

```md
---
name: Existing project
unit: 1080 square
# keep this comment
colors:
  primary: '#123456'
typography:
  body: { fontFamily: 'Inter' }
custom:
  evidenceMode: true
---

# Existing project direction

Preserve this paragraph exactly.
```

- [ ] **Step 2: Run frontmatter tests and verify RED**

Run:

```bash
node --test skills/tanzu-brand/tests/frontmatter.test.mjs
```

Expected: FAIL because `frontmatter.mjs` does not exist.

- [ ] **Step 3: Implement top-level section replacement**

Implement a line-oriented parser that:

1. Requires opening and closing `---`.
2. Detects unindented `key:` lines.
3. Treats every line until the next unindented key as that section.
4. Replaces named sections from generated canonical frontmatter.
5. Appends a missing managed section immediately before closing `---`.
6. Never parses or rewrites preserved sections.

Malformed or missing frontmatter returns a typed error; it never overwrites the
source.

Use a section index rather than a YAML serializer:

```js
export function replaceTopLevelSections(markdown, replacements) {
  const lines = markdown.split('\n');
  if (lines[0] !== '---') throw new FrontmatterError('opening delimiter missing');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new FrontmatterError('closing delimiter missing');

  const frontmatter = lines.slice(1, end);
  const starts = frontmatter
    .map((line, index) => {
      const match = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line);
      return match ? { key: match[1], index } : null;
    })
    .filter(Boolean);

  const used = new Set();
  const merged = frontmatter.slice(0, starts[0]?.index ?? frontmatter.length);
  for (let index = 0; index < starts.length; index += 1) {
    const { key, index: from } = starts[index];
    const to = starts[index + 1]?.index ?? frontmatter.length;
    if (replacements.has(key)) {
      merged.push(...replacements.get(key).split('\n'));
      used.add(key);
    } else {
      merged.push(...frontmatter.slice(from, to));
    }
  }
  for (const [key, replacement] of replacements) {
    if (!used.has(key)) merged.push(...replacement.split('\n'));
  }
  return ['---', ...merged, '---', ...lines.slice(end + 1)].join('\n');
}
```

- [ ] **Step 4: Run frontmatter tests and verify GREEN**

Run:

```bash
node --test skills/tanzu-brand/tests/frontmatter.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Write failing apply tests**

Use `mkdtemp` fixtures to assert:

- an empty project receives `frame.md`, `.brand/tanzu/tokens.json`,
  `.brand/tanzu/tokens.css`, approved logos/avatars/bumpers, and
  `.brand/tanzu/applied.json`;
- first application creates `.brand/tanzu/options.json` with both bumper roles
  enabled, while a later application preserves user-edited opt-outs;
- existing `frame.md` gets a one-time backup at
  `.brand/tanzu/original-frame.md`;
- project-specific frontmatter/body survives;
- `dryRun: true` writes nothing;
- a second real run reports no changed files;
- copied asset hashes equal the canonical manifest;
- applied bumper roles are light intro and dark outro with
  `enabledByDefault: true`;
- the legacy bumper is absent.

- [ ] **Step 6: Run apply tests and verify RED**

Run:

```bash
node --test skills/tanzu-brand/tests/apply.test.mjs
```

Expected: FAIL because apply implementation does not exist.

- [ ] **Step 7: Implement atomic, idempotent application**

Implement `applyBrand` with:

- `fs.mkdtemp` staging under the target project's `.brand/`;
- `copyFile` for immutable assets;
- write-to-temp plus `rename` for text files;
- a one-time backup before first existing-`frame.md` merge;
- generated `applied.json`:

```json
{
  "brandId": "tanzu-division",
  "brandVersion": "2026.02",
  "bumpers": {
    "intro": ".brand/tanzu/assets/bumpers/vmware-tanzu-intro-light.mp4",
    "outro": ".brand/tanzu/assets/bumpers/vmware-tanzu-outro-dark.mp4",
    "enabledByDefault": true
  },
  "assets": {}
}
```

Populate `assets` from the canonical manifest with project-relative path and
SHA-256. Create mutable `.brand/tanzu/options.json` once:

```json
{
  "bumperIntro": true,
  "bumperOutro": true
}
```

Never overwrite an existing `options.json`; this is the tool-neutral explicit
opt-out contract. Compare bytes before writing so repeat application is a
no-op.

`apply-brand.mjs` accepts:

```text
--project <absolute-or-relative-directory>
--dry-run
```

It prints changed/unchanged files and the next audit command. Unknown arguments
exit 2 without writes.

- [ ] **Step 8: Run apply tests and verify GREEN**

Run:

```bash
node --test skills/tanzu-brand/tests/frontmatter.test.mjs skills/tanzu-brand/tests/apply.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit safe application**

```bash
git add skills/tanzu-brand/scripts/lib/frontmatter.mjs skills/tanzu-brand/scripts/lib/apply.mjs skills/tanzu-brand/scripts/apply-brand.mjs skills/tanzu-brand/tests/frontmatter.test.mjs skills/tanzu-brand/tests/apply.test.mjs
git commit -m "feat: apply Tanzu brand package safely"
```

---

### Task 6: Audit source and final-render brand compliance

**Files:**

- Create: `skills/tanzu-brand/scripts/lib/audit.mjs`
- Create: `skills/tanzu-brand/scripts/lib/report.mjs`
- Create: `skills/tanzu-brand/scripts/audit-brand.mjs`
- Create: `skills/tanzu-brand/tests/audit.test.mjs`

**Interfaces:**

- Consumes: Applied project, canonical tokens/manifests, optional source-fix mode.
- Produces:
  - `contrastRatio(foreground: string, background: string): number`
  - `ExecFn = (file: string, args: string[]) => Promise<{ stdout: string }>`
  - `resolveArial(exec?: ExecFn): Promise<'Arial'|'missing'|'unresolved'>`
  - `auditProject({ projectRoot, phase, fix, exec? }): Promise<BrandReport>`
  - `BrandReport = { status: 'PASS'|'PASS WITH WARNINGS'|'BLOCKED', corrected: Finding[], warnings: Finding[], blockers: Finding[] }`.

- [ ] **Step 1: Write failing audit tests**

Cover these exact cases:

```js
test('AA alternatives pass on White while bright originals fail', () => {
  assert.equal(contrastRatio('#0098C7', '#FFFFFF').toFixed(2), '3.32');
  assert.equal(contrastRatio('#007DA3', '#FFFFFF').toFixed(2), '4.71');
  assert.equal(contrastRatio('#61A60E', '#FFFFFF').toFixed(2), '3.01');
  assert.equal(contrastRatio('#23800A', '#FFFFFF').toFixed(2), '5.04');
});

test('final audit blocks when Arial resolves to Helvetica', async () => {
  const report = await auditProject({
    projectRoot,
    phase: 'final',
    exec: fakeFcMatch('Helvetica'),
  });
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.blockers[0].ruleId, 'font.actual-arial-required');
});

test('source fix corrects safe declarations only', async () => {
  await writeFile(
    sourceCss,
    '.lower-third{font-family:Inter;color:#61A60E;background:#FFFFFF;border-radius:9999px}.avatar{border-radius:50%}',
  );
  const report = await auditProject({ projectRoot, phase: 'source', fix: true });
  assert.match(await readFile(sourceCss, 'utf8'), /font-family:Arial, Helvetica, sans-serif/);
  assert.match(await readFile(sourceCss, 'utf8'), /color:#23800A/);
  assert.match(await readFile(sourceCss, 'utf8'), /\.lower-third[^}]*border-radius:0/);
  assert.match(await readFile(sourceCss, 'utf8'), /\.avatar[^}]*border-radius:50%/);
  assert.equal(report.blockers.length, 0);
});
```

Also test:

- approved source hashes pass;
- swapped bumper roles are corrected;
- modified bumper source is replaced from canonical assets when `fix` is true;
- legacy denied hash blocks;
- explicit bumper opt-out passes;
- unresolved contrast blocks;
- an approved logo referenced with a changed width/height ratio blocks;
- an unknown logo-like source path blocks pending provenance;
- a non-palette decorative hex warns when no safe semantic mapping exists;
- reports write stable Markdown and JSON;
- `--self` validates the source skill package without a project application;
- only `BLOCKED` maps to nonzero CLI status.

- [ ] **Step 2: Run audit tests and verify RED**

Run:

```bash
node --test skills/tanzu-brand/tests/audit.test.mjs
```

Expected: FAIL because audit modules do not exist.

- [ ] **Step 3: Implement contrast, font, asset, and source checks**

Implement WCAG 2 relative luminance and ratio without rounding internally.

```js
function luminance(hex) {
  const channels = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
}
```

`resolveArial` runs:

```text
fc-match -f %{family}\n Arial
```

Normalize comma-separated family output and return `Arial` only when the first
resolved family is exactly Arial. If `fc-match` is unavailable, return
`unresolved`: source phase warns; final phase blocks.

Scan `.css`, `.html`, `.js`, `.mjs`, `.ts`, `.tsx`, `.json`, and `.md` while
excluding `.git`, `node_modules`, render output, and `.brand/tanzu` canonical
copies. Safe fixes are limited to:

- `font-family` declarations in editable source;
- Green/Azure used as the CSS `color` property against an explicit White or
  Broadcom Gray background in the same rule;
- rectangular selectors containing `card`, `panel`, `caption`, `lower-third`,
  `lower_third`, `title`, or `node`.

Never rewrite selectors containing `avatar`, `circle`, `ring`, or `medallion`.
Ambiguous cases warn.

For HTML/CSS logo references, compare declared width/height ratio against the
approved source ratio when both dimensions are available. A difference above
1% blocks. A logo-like path that is not present in the allow manifest also
blocks. Non-palette hex colors warn unless a deterministic Green/Azure text
substitution applies.

Verify project-local immutable assets against `applied.json` and canonical
allow/deny hashes. `ffprobe` project-local bumper sources and verify role,
dimensions, duration, fps, codec, pixel format, and absence of audio. Read
`.brand/tanzu/options.json`; a `false` intro or outro value is an explicit
opt-out and passes without deleting the canonical source asset.

- [ ] **Step 4: Implement stable reports and CLI behavior**

Write:

```text
.brand/tanzu/brand-audit.json
.brand/tanzu/brand-audit.md
```

Every finding contains `severity`, `ruleId`, `location`, `observed`,
`expected`, `corrected`, and `remediation`. Sort findings by severity,
location, then rule ID.

CLI:

```text
node scripts/audit-brand.mjs --project <dir> --phase source [--fix]
node scripts/audit-brand.mjs --project <dir> --phase final
node scripts/audit-brand.mjs --self
```

Exit 0 for PASS and PASS WITH WARNINGS; exit 2 for BLOCKED or invalid
arguments.

- [ ] **Step 5: Run audit tests and verify GREEN**

Run:

```bash
node --test skills/tanzu-brand/tests/audit.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit the auditor**

```bash
git add skills/tanzu-brand/scripts/lib/audit.mjs skills/tanzu-brand/scripts/lib/report.mjs skills/tanzu-brand/scripts/audit-brand.mjs skills/tanzu-brand/tests/audit.test.mjs
git commit -m "feat: audit Tanzu brand compliance"
```

---

### Task 7: Author the minimal skill and heavy references

**Files:**

- Create: `skills/tanzu-brand/SKILL.md`
- Create: `skills/tanzu-brand/references/brand-rules.md`
- Create: `skills/tanzu-brand/references/video-application.md`
- Create: `skills/tanzu-brand/references/accessibility.md`
- Create: `skills/tanzu-brand/references/provenance.md`
- Create: `skills/tanzu-brand/tests/skill-contract.test.mjs`

**Interfaces:**

- Consumes: Baseline rationalizations and all deterministic package interfaces.
- Produces: Discoverable skill workflow plus complete references; no duplicated token values that can drift from `tokens.json`.

- [ ] **Step 1: Write failing skill-contract tests**

Assert:

- `SKILL.md` frontmatter has only `name` and `description`;
- name is `tanzu-brand`;
- description exactly matches the approved trigger;
- body is at most 500 words;
- it requires loading canonical tokens, applying the brand, running source
  audit, running final audit, and stopping on the three critical blockers;
- it explicitly pairs with other production skills;
- every referenced file exists;
- references contain the required headings from the specification;
- `provenance.md` contains the PPT hash, approved bumper hashes, and denied
  legacy hash.

- [ ] **Step 2: Run contract tests and verify RED**

Run:

```bash
node --test skills/tanzu-brand/tests/skill-contract.test.mjs
```

Expected: FAIL because skill and references do not exist.

- [ ] **Step 3: Write the concise skill router**

Use this exact frontmatter:

```yaml
---
name: tanzu-brand
description: Use when creating, editing, reviewing, or rendering Tanzu Division, VMware Tanzu, TNZ, or VMware by Broadcom-branded video, motion graphics, captions, lower thirds, title cards, diagrams, presentations, or related visual media.
---
```

The body must state this workflow in order:

1. Load `brand/tokens.json`, `brand/asset-manifest.json`, and only the relevant
   reference file.
2. Pair with the active production skill; this skill supplies brand, not story
   or motion.
3. Run `apply-brand.mjs --project <dir>` before authoring branded frames.
4. Use approved local assets; default to the light intro and dark outro unless
   explicitly opted out.
5. Run source audit with safe corrections.
6. Run final audit and visually inspect representative frames.
7. Stop final output for actual-Arial failure, unresolved WCAG AA, or
   outdated/altered/unknown logo or bumper.

Include a compact quick-reference table for Correct / Warn / Block. Do not
repeat the full palette in `SKILL.md`; route to canonical data.

- [ ] **Step 4: Write focused references**

`brand-rules.md` contains typography, semantic palette roles, geometry,
language, logo immutability, and do/don't guidance.

`video-application.md` contains titles, captions, lower thirds, UI captures,
diagrams, intro/outro, 16:9 and non-16:9 bumper handling, and forward-looking
content warnings.

`accessibility.md` contains exact WCAG thresholds, AA Green/Azure behavior,
resolved-pair auditing, and color-not-alone guidance.

`provenance.md` contains:

- source titles, paths, URLs, and hashes;
- PPT media-to-packaged-asset mapping;
- VPA bumper assignments and media properties;
- internal-only redistribution status;
- the explicit exclusion of VPA's conflicting rounded/pill tokens;
- font subset exclusion and licensing boundary.

- [ ] **Step 5: Run contract tests and verify GREEN**

Run:

```bash
node --test skills/tanzu-brand/tests/skill-contract.test.mjs
wc -w skills/tanzu-brand/SKILL.md
```

Expected: tests PASS and `SKILL.md` is no more than 500 words.

- [ ] **Step 6: Commit the skill guidance**

```bash
git add skills/tanzu-brand/SKILL.md skills/tanzu-brand/references skills/tanzu-brand/tests/skill-contract.test.mjs
git commit -m "feat: add Tanzu brand skill guidance"
```

---

### Task 8: Run GREEN agent scenarios and close observed loopholes

**Files:**

- Modify only when evidence requires: `skills/tanzu-brand/SKILL.md`
- Modify only when evidence requires: `skills/tanzu-brand/references/*.md`
- Create: `skills/tanzu-brand/tests/evidence/green-<scenario>-<rep>.md`
- Create: `skills/tanzu-brand/tests/evidence/green-summary.md`

**Interfaces:**

- Consumes: The unchanged scenario prompts and rubric from Task 1.
- Produces: Evidence that fresh agents find and follow the skill under pressure.

- [ ] **Step 1: Repeat the critical micro-tests with the skill loaded**

Dispatch fresh isolated agents with `tanzu-brand` available:

- `lower-third-pressure`: 5 repetitions
- `legacy-bumper-pressure`: 5 repetitions
- `missing-arial-pressure`: 5 repetitions

Save verbatim responses and manually score every rubric item.

- [ ] **Step 2: Run all remaining application scenarios**

Run one fresh isolated agent each for `dark-ui`, `dense-diagram`, and
`forward-looking`. Save and score the responses.

- [ ] **Step 3: Verify GREEN**

Create `green-summary.md` with the same columns as the baseline. Every critical
scenario repetition must pass every critical rule. Each other scenario must
pass in at least one fresh-context run without relying on conversation history.

- [ ] **Step 4: Refactor only against observed rationalizations**

If an agent finds a loophole, quote the rationalization in the evidence and add
the smallest matching rule to `SKILL.md` or the relevant reference. Specifically
probe:

```text
The logo is very small, so recoloring is harmless.
Helvetica is close enough for the deadline.
The caption pill belongs to the template, so brand geometry does not apply.
All gradient colors are approved, so unlimited gradients are compliant.
The screenshot came from the user, so dark-mode guidance does not apply.
The legacy bumper has audio, so it is more complete than the approved pair.
```

Re-run the failed scenario with a fresh agent until it passes. Do not add
guidance for hypothetical failures that did not occur.

- [ ] **Step 5: Re-run deterministic skill tests**

Run:

```bash
npm run test:skills
```

Expected: PASS.

- [ ] **Step 6: Commit verified guidance and evidence**

```bash
git add skills/tanzu-brand/SKILL.md skills/tanzu-brand/references skills/tanzu-brand/tests/evidence
git commit -m "test: verify Tanzu brand skill behavior"
```

---

### Task 9: Add safe cross-runtime installation

**Files:**

- Create: `skills/tanzu-brand/scripts/install-skill.mjs`
- Create: `skills/tanzu-brand/tests/install.test.mjs`

**Interfaces:**

- Consumes: Verified repository skill package.
- Produces: `installSkill({ sourceRoot, targetRoot, dryRun, replace }): Promise<InstallResult>`.

- [ ] **Step 1: Write failing installer tests**

Using temporary directories, assert:

- dry run reports files and writes nothing;
- new target receives `SKILL.md`, `brand`, `assets`, `references`, and
  executable scripts;
- `tests/evidence` is not installed;
- every installed immutable asset matches the canonical hash;
- installed `brand/install-manifest.json` records `brandVersion: "2026.02"`
  and the source Git commit;
- reinstalling the same version is a no-op;
- a different existing target refuses without `--replace`;
- `--replace` creates a sibling timestamped backup before atomic rename.

- [ ] **Step 2: Run installer tests and verify RED**

Run:

```bash
node --test skills/tanzu-brand/tests/install.test.mjs
```

Expected: FAIL because installer does not exist.

- [ ] **Step 3: Implement staged verified installation**

The CLI accepts:

```text
--target <directory>
--dry-run
--replace
```

Default target is `~/.agents/skills/tanzu-brand`. Expand the home directory
with `os.homedir()`; do not rely on shell expansion.

Copy into a sibling staging directory, validate the copied skill and asset
hashes, then rename atomically. On replacement, rename the previous target to
`tanzu-brand.backup-<UTC timestamp>` before promoting staging. If promotion
fails, restore the backup.

Resolve the source commit with `git rev-parse HEAD` from the repository source
root and write this generated file into staging before validation:

```js
await writeFile(
  join(stagingRoot, 'brand/install-manifest.json'),
  `${JSON.stringify({ brandVersion: '2026.02', sourceCommit }, null, 2)}\n`,
);
```

The test passes a deterministic 40-character SHA into `installSkill`; the CLI
is responsible for resolving the real repository SHA.

- [ ] **Step 4: Run installer tests and verify GREEN**

Run:

```bash
node --test skills/tanzu-brand/tests/install.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit installer**

```bash
git add skills/tanzu-brand/scripts/install-skill.mjs skills/tanzu-brand/tests/install.test.mjs
git commit -m "feat: install Tanzu brand skill safely"
```

---

### Task 10: Document, verify, and install the finished skill

**Files:**

- Modify: `README.md`
- Verify: all `skills/tanzu-brand/**`
- Install after approval: `~/.agents/skills/tanzu-brand/**`

**Interfaces:**

- Consumes: All completed tasks.
- Produces: Fully verified repository package and installed personal skill.

- [ ] **Step 1: Document the repository skill**

Add a short `Reusable Tanzu brand skill` section to `README.md` containing:

```markdown
The repository includes `skills/tanzu-brand`, a portable brand package for Tanzu video and visual-media work. It carries the February 2026 tokens, approved logos/avatars, the active light intro and dark outro bumpers, project apply/audit scripts, and provenance. Run `npm run test:skills` to verify it.
```

- [ ] **Step 2: Format and run the targeted skill suite**

Run:

```bash
./node_modules/.bin/prettier --check package.json README.md docs/superpowers skills/tanzu-brand
npm run test:skills
node skills/tanzu-brand/scripts/generate-adapters.mjs
git diff --exit-code -- skills/tanzu-brand/brand/frame.md skills/tanzu-brand/brand/tokens.css
node skills/tanzu-brand/scripts/audit-brand.mjs --self
```

Expected: formatting passes, all skill tests pass, generation is reproducible,
and self-audit is not BLOCKED.

- [ ] **Step 3: Run the full relevant repository checks**

Run once at the milestone:

```bash
npm test
npm run lint
npm run typecheck
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Commit final documentation**

```bash
git add README.md
git commit -m "docs: document Tanzu brand skill"
```

- [ ] **Step 5: Request approval and install to the personal skill directory**

Request filesystem approval for the exact target, then run:

```bash
node skills/tanzu-brand/scripts/install-skill.mjs --target /Users/dbbaskette/.agents/skills/tanzu-brand
```

Do not pass `--replace` unless the target already exists and the user approves
replacement after seeing the installer report.

- [ ] **Step 6: Verify the installed copy**

Run:

```bash
node /Users/dbbaskette/.agents/skills/tanzu-brand/scripts/audit-brand.mjs --self
shasum -a 256 \
  /Users/dbbaskette/.agents/skills/tanzu-brand/assets/bumpers/vmware-tanzu-intro-light.mp4 \
  /Users/dbbaskette/.agents/skills/tanzu-brand/assets/bumpers/vmware-tanzu-outro-dark.mp4
```

Expected hashes:

```text
d2f2690890855dbf29c438f1e21ecc2428666d869abb4309144f23e303473a9f
9a2d294b615f518c523dcb13b7599a167fb0ece87942578e2f71d930a14de7ab
```

- [ ] **Step 7: Final clean-state verification**

Run:

```bash
git status --short --branch
git log --oneline -12
```

Expected: no uncommitted repository changes; the task branch contains the
incremental commits from this plan.

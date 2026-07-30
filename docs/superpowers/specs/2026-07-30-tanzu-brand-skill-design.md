# Tanzu Brand Skill — Design

**Date:** 2026-07-30

**Status:** Approved design (pending implementation)

**Skill name:** `tanzu-brand`

## Summary

Create a portable, cross-runtime `tanzu-brand` skill that carries the
authoritative Tanzu Division brand details needed for video and motion work.
The skill will pair with the existing HyperFrames video skills while also
providing tool-neutral JSON, CSS, font, and asset manifests for other renderers.

The skill will:

- apply exact typography, palette, logo, geometry, accessibility, and
  composition rules;
- provide approved deck-extracted logo and avatar assets with provenance;
- provide the active VPA light intro and dark outro bumper videos;
- generate adapters such as `frame.md` and CSS variables from one canonical
  token file;
- automatically correct safe deviations;
- warn about judgment-based stylistic deviations; and
- block final output only for critical failures: an altered or outdated logo,
  unresolved WCAG AA contrast, or unavailable Arial.

This version is deliberately independent of the VPA Brand wizard. Wizard
import/export and Brand Library integration can be designed later.

## Source and authority

Primary source:

- **Title:** Slide Style Guide - TNZ Division - 2026
- **Published:** February 2026
- **Local source during design:** `/Users/dbbaskette/Downloads/Slide Style Guide - TNZ Division - 2026 (1).pptx`
- **SHA-256:** `4c6c82a7970bb011c9708967b2377cffee0e17e4d2a11e23d8ec4cfac281a490`

All 64 slides were inspected. Authority is resolved in this order:

1. Explicit rules on slides 3–9.
2. Explicit disclaimer guidance on slide 12.
3. Repeated visual patterns in example slides 13–25.
4. Repeated visual patterns in layouts 26–64.
5. Incidental formatting or imported content is not a brand rule.

This prevents example-only fonts, colors, graphics, and annotations from being
promoted to brand law.

The source deck links to the upstream logo and product-icon folder:

`https://drive.google.com/drive/folders/1JqCoa93fv1cAVS47XnjRw1EWZB_nUEYy`

The skill will record that URL as provenance. The initial skill remains usable
with deck-extracted assets if the upstream folder is unavailable.

Secondary source for bumper assignments and files:

- **VPA brand:** `vmware-tanzu`
- **Brand definition:** `/Users/dbbaskette/.vpa/brands/vmware-tanzu/design.md`
- **Active intro:** `assets/bumpers/VMwareTanzu-logo-animation-light.mp4`
- **Active outro:** `assets/bumpers/VMwareTanzu-logo-animation-dark.mp4`

Only these two active bumper assignments are authoritative. Other design tokens
in the VPA-generated `design.md` are not imported because some conflict with
the February 2026 guide, notably its rounded-card and pill guidance.

## Design decisions

1. **One canonical token source.** `brand/tokens.json` is the package-level
   source of truth. Tool adapters are generated from it and verified against it.
2. **Video-first, tool-neutral.** `frame.md` integrates with HyperFrames;
   `tokens.json` and `tokens.css` support other tools.
3. **No font redistribution.** Arial is referenced as a licensed/system font.
   Subset Roboto and Proxima Nova files embedded in the PowerPoint are not
   extracted or redistributed.
4. **Exact values, semantic roles.** Raw colors are preserved exactly and also
   mapped to roles such as canvas, ink, accent, and status.
5. **Brand assets are immutable.** Approved logo and bumper source files are
   checksum-verified. Known outdated assets are held only as forbidden
   checksums, not as usable assets.
6. **Safe correction, narrow blocking.** The skill corrects deterministic
   token-level problems and reserves hard stops for critical output failures.
7. **No invented motion doctrine.** The static guide governs visual identity.
   Existing video skills continue to govern animation, pacing, and transitions.

## Package structure

The source package will live in the VPA repository for review and versioning:

```text
skills/tanzu-brand/
├── SKILL.md
├── brand/
│   ├── tokens.json
│   ├── tokens.schema.json
│   ├── frame.md
│   ├── tokens.css
│   ├── font-manifest.json
│   └── asset-manifest.json
├── assets/
│   ├── logos/
│   │   ├── tanzu-bug-color.png
│   │   └── vmware-tanzu-lockup-black.png
│   ├── bumpers/
│   │   ├── vmware-tanzu-intro-light.mp4
│   │   └── vmware-tanzu-outro-dark.mp4
│   └── avatars/
│       ├── avatar-01.png
│       ├── avatar-02.png
│       ├── avatar-03.png
│       ├── avatar-04.png
│       ├── avatar-05.png
│       └── avatar-06.png
├── references/
│   ├── brand-rules.md
│   ├── video-application.md
│   ├── accessibility.md
│   └── provenance.md
├── scripts/
│   ├── apply-brand.mjs
│   └── audit-brand.mjs
└── tests/
    ├── fixtures/
    └── scenarios.md
```

After verification, the package will be installed to the cross-runtime personal
skill location:

```text
~/.agents/skills/tanzu-brand/
```

Installation outside the repository requires explicit filesystem approval.

## Skill discovery and triggering

Proposed frontmatter:

```yaml
---
name: tanzu-brand
description: Use when creating, editing, reviewing, or rendering Tanzu Division, VMware Tanzu, TNZ, or VMware by Broadcom-branded video, motion graphics, captions, lower thirds, title cards, diagrams, presentations, or related visual media.
---
```

The skill should be loaded alongside the applicable production skill, not
instead of it. Examples:

- `hyperframes` + `product-launch-video` + `tanzu-brand`
- `hyperframes` + `motion-graphics` + `tanzu-brand`
- `embedded-captions` + `tanzu-brand`
- `presentations` + `tanzu-brand`

`SKILL.md` stays concise and routes agents to the canonical tokens, the
appropriate application reference, and the apply/audit commands.

## Canonical token model

`brand/tokens.json` will use a versioned schema. Its top-level shape:

```json
{
  "schemaVersion": 1,
  "brandId": "tanzu-division",
  "brandVersion": "2026.02",
  "source": {},
  "typography": {},
  "colors": {
    "raw": {},
    "roles": {}
  },
  "geometry": {},
  "imagery": {},
  "logos": {},
  "accessibility": {},
  "language": {},
  "video": {}
}
```

The schema will reject unknown required token names and malformed colors.
Generated `frame.md` and `tokens.css` will identify their source version so the
audit can detect stale adapters.

## Typography

### Approved family

- **Primary display:** Arial
- **Primary body:** Arial
- **Approved styles:** Regular, Bold, Italic, Bold Italic
- **CSS declaration:** `Arial, Helvetica, sans-serif`

The fallback stack is for editing and preview resilience only. Final rendering
must resolve the actual Arial family.

### Font manifest

`font-manifest.json` will record:

- family name and approved styles;
- `sourceType: "system-or-user-licensed"`;
- `redistributable: false`;
- accepted user-supplied desktop formats: `.otf` and `.ttf`;
- optional web adapter format: `.woff2`, derived only from a font the user is
  licensed to convert;
- preview fallback stack;
- final-render policy: block if Arial is unresolved.

The package will not contain:

- the PowerPoint's subset Roboto files;
- the PowerPoint's subset Proxima Nova files; or
- a substituted open-source font represented as Arial.

### Sizing

The PowerPoint's point sizes are slide-specific and will not become fixed video
sizes. The skill will preserve relationships instead:

- headings are larger than supporting copy;
- bold is used for emphasis, not as the default for all text;
- captions and lower thirds must remain readable at delivery resolution; and
- title and caption sizes are chosen by the active video workflow and audited
  visually at the final output size.

## Color system

### Named source colors

| Token         |       Hex | Default role                              |
| ------------- | --------: | ----------------------------------------- |
| Black         | `#000000` | Maximum-contrast ink                      |
| White         | `#FFFFFF` | Primary canvas / reverse ink              |
| Dark Blue     | `#1B1D36` | Dark ink / deep surface                   |
| Blue          | `#005C8A` | Primary heading / brand accent            |
| Aqua          | `#007B8C` | Core accent                               |
| Purple        | `#6C4B94` | Core accent / current-logo identity       |
| Azure         | `#0098C7` | Bright accent, not small text on white    |
| Green         | `#61A60E` | Bright accent, not small text on white    |
| Red           | `#CC092F` | Status / warning accent                   |
| Orange        | `#E68C28` | Warm accent                               |
| Yellow        | `#F3BA16` | Highlight accent                          |
| Dark Gray     | `#53565A` | Secondary ink                             |
| Cool Gray 7   | `#97999B` | Muted decoration / large noncritical text |
| Broadcom Gray | `#E2E3E4` | Secondary canvas / quiet panel            |

### Accessibility alternatives

| Original        | AA alternative | Use                             |
| --------------- | -------------: | ------------------------------- |
| Azure `#0098C7` |      `#007DA3` | Readable text on a light canvas |
| Green `#61A60E` |      `#23800A` | Readable text on a light canvas |

The original bright Azure and Green remain valid for decorative shapes,
large-area accents, and combinations that independently pass contrast.

### Semantic roles

Generated adapters will expose roles rather than forcing tools to choose raw
swatches:

- `canvas.primary`: White
- `canvas.secondary`: Broadcom Gray
- `ink.primary`: Black or Dark Blue
- `ink.secondary`: Dark Gray
- `heading.primary`: Blue
- `accent.aqua`: Aqua
- `accent.purple`: Purple
- `accent.azure`: Azure
- `accent.green`: Green
- `accent.azureText`: AA Azure
- `accent.greenText`: AA Green
- `status.critical`: Red
- `status.attention`: Orange
- `status.highlight`: Yellow

The implementation may add adapter aliases, but it must not change raw values.

## Logo rules

1. Use only the current Tanzu bug and wordmark.
2. The current bug includes Purple.
3. Do not redraw, recolor, crop, stretch, distort, mask, decorate, or place
   another image inside the bug.
4. Preserve alpha transparency and aspect ratio.
5. Do not recreate the wordmark with typed text.
6. Do not treat the VMware by Broadcom slide footer as a mandatory persistent
   video watermark.
7. Prefer an upstream vector master when one becomes available. Until then,
   do not enlarge a deck-extracted raster beyond a visually safe size.

### Approved initial assets

| Packaged name                   | PPT media source        | Dimensions | SHA-256                                                            |
| ------------------------------- | ----------------------- | ---------: | ------------------------------------------------------------------ |
| `tanzu-bug-color.png`           | `ppt/media/image26.png` |    448×437 | `b5923be854f8be2eab54ecf8c1fa9894d81d25cb74df3c6fb745910e59c70a9c` |
| `vmware-tanzu-lockup-black.png` | `ppt/media/image21.png` |    323×327 | `834f41e63ef8c9ff66782bf1ccbf5bdd52e15b27acb41123b94cdb84d661ab40` |

### Known forbidden asset

The outdated bug lacks Purple and uses retired blues:

- PPT source: `ppt/media/image19.png`
- SHA-256:
  `ad0f78978471deca15a768c4d954f1d0892a983052ad7f84b06433221cea1ad6`

The skill stores this checksum in the manifest's deny list, not the image file.

## Avatar assets

The six updated persona avatars from slide 5 will be packaged as neutral,
numbered assets. The skill will not infer names, roles, gender, ethnicity, or
job titles from their appearance.

| Packaged name   | PPT media source | Dimensions | SHA-256                                                            |
| --------------- | ---------------- | ---------: | ------------------------------------------------------------------ |
| `avatar-01.png` | `image17.png`    |  1200×1268 | `6b3c0f464deff2c12b1197ff22f12039a93b232a076845e2c773cda4d73e7fde` |
| `avatar-02.png` | `image18.png`    |  1167×1270 | `3d0874d4b7c24cd5986e1dbf7382284f1e23bc9eb6da22a7e6c54825be56fa5e` |
| `avatar-03.png` | `image20.png`    |  1167×1270 | `ad986e34083c18411727d628b1fcfaa2b3a30c1942d73f2fc53b0568015b086c` |
| `avatar-04.png` | `image22.png`    |  1200×1369 | `5d8d2df52364b069993dbc7bd73499bcf098e62f82e845a99e187800446316b5` |
| `avatar-05.png` | `image23.png`    |  1199×1278 | `579f6a6b03131448c10302939112ab698c71420418d61d9d72e51d3f60268ba5` |
| `avatar-06.png` | `image24.png`    |  1200×1279 | `4680708d4ef1f347c06df346d5b1227d607f24d9f6fe329eede4bbd84d5f64f9` |

Provenance will state that these are deck-extracted internal brand assets and
must not be redistributed as a public asset pack without authorization.

## Bumper video assets

The skill will package the two bumper files currently assigned by VPA's active
`vmware-tanzu` brand:

| Packaged name                  | VPA source                             | Role  | Media properties                                          | SHA-256                                                            |
| ------------------------------ | -------------------------------------- | ----- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| `vmware-tanzu-intro-light.mp4` | `VMwareTanzu-logo-animation-light.mp4` | Intro | 1920×1080, 3.003 s, 30000/1001 fps, H.264 yuv420p, silent | `d2f2690890855dbf29c438f1e21ecc2428666d869abb4309144f23e303473a9f` |
| `vmware-tanzu-outro-dark.mp4`  | `VMwareTanzu-logo-animation-dark.mp4`  | Outro | 1920×1080, 3.003 s, 30000/1001 fps, H.264 yuv420p, silent | `9a2d294b615f518c523dcb13b7599a167fb0ece87942578e2f71d930a14de7ab` |

Both use the current Purple-inclusive Tanzu bug and the VMware Tanzu wordmark.
The packaged files remain byte-for-byte copies of the VPA source assets.
Provenance will identify them as internal brand assets that must not be
redistributed as a public bumper pack without authorization.

### Bumper usage

- Apply the light bumper as the default intro and the dark bumper as the default
  outro when the production format supports brand bumpers.
- A project or render may explicitly opt out of either or both bumpers.
- Preserve each complete 3.003-second source; do not trim, speed-ramp, recolor,
  crop, reverse, mask, overlay, or otherwise edit its internal artwork.
- Join bumpers to program material with a clean cut unless the user explicitly
  requests a separately approved transition.
- Scale proportionally. For non-16:9 output, pad outside the source frame using
  a matching White or Dark Blue surface rather than cropping the logo.
- The bumper source files are silent. Music, sonic logos, and sound design
  remain owned by the active production workflow and are not added by this
  brand package.
- Normalized or transcoded render intermediates may differ from the canonical
  file checksum, but the project-local source copy must retain the approved
  checksum.

### Forbidden legacy bumper

`TanzuVMware.mp4` is a 10-second, 1280×720 legacy animation that uses the
retired no-Purple Tanzu bug. It must not be packaged or used:

- SHA-256:
  `655aedb53e29b3122c1ff4aada6090feaec35c8c3639069c0789a2ee3c3cb5fa`

The manifest stores this checksum in the video deny list without copying the
legacy file into the skill.

## Geometry and composition

### Required

- Square corners for cards, panels, labels, title blocks, and diagram nodes.
- Sentence case for titles and headlines.
- Light presentation for UI screenshots.
- White or Broadcom Gray as the default frame canvas.
- Sparse, deliberate use of the core accent colors.
- Clean spacing and clear hierarchy.

### Allowed patterns

- Thin rules and dividers.
- Square outlined cards.
- Filled arrows with fishtails.
- White outlined arrows.
- Circular topic rings and avatar medallions.
- Green–Blue and Blue–Purple gradients.
- A restrained multicolor rule using Green, Aqua/Azure, Blue, and Purple.

Circles and avatar medallions are explicitly allowed; “square corners” applies
to rectangular containers and does not prohibit true circular graphics.

### Discouraged

- Rounded cards or pill-shaped containers.
- Heavy or repeated gradients, especially inside diagrams.
- Dark-mode UI screenshots when a light alternative exists.
- Too many accent colors competing within one frame.
- Decorative shadows that overwhelm the flat, clean source style.
- Treating every example-layout element as mandatory video chrome.

## Video application

The skill will translate the static guide to video without copying slide
layouts literally.

### Titles and title cards

- Arial.
- Sentence case.
- Blue heading on White or Broadcom Gray by default.
- Square-edged blocks when a container is used.
- Optional restrained brand rule or brand gradient.

### Captions

- Arial with WCAG AA contrast.
- Prefer a square rail, square panel, or unboxed text with a controlled
  contrast surface.
- Avoid pill captions as the default treatment.
- Preserve delivery-safe margins and inspect at final resolution.

### Lower thirds

- Arial; name may be Bold and descriptor Regular.
- Square geometry.
- Blue, Aqua, Purple, AA Azure, or AA Green may be used by role.
- Logo use is optional; if present, the approved checksum asset is required.

### UI captures

- Prefer the application's light mode.
- If only dark mode exists, do not fabricate a light UI. Emit a warning and
  use a light outer frame or canvas where appropriate.
- Do not crop meaningful UI labels, controls, logos, or evidence.

### Diagrams and data graphics

- Square nodes, thin rules, restrained accents, and minimal gradients.
- Use color to encode meaning, not decoration alone.
- Do not rely on color as the only carrier of meaning.

### Intro and outro

- Use the packaged light intro and dark outro by default when the production
  format supports bumpers and the project has not opted out.
- For a bespoke intro or outro, the current wordmark or bug may be used.
- Do not require a persistent footer.
- Motion must preserve the logo artwork as an indivisible visual asset.

### Forward-looking content

When a video includes roadmap or other forward-looking information, the skill
will warn that the source guide requires a disclaimer for presentations. It
will not automatically paste the slide disclaimer into a video; the user must
confirm the appropriate video/legal treatment.

## Accessibility

The audit will enforce WCAG AA:

- normal text: contrast ratio at least 4.5:1;
- large text: contrast ratio at least 3:1;
- meaningful non-text UI and graphical indicators: at least 3:1 where
  applicable;
- captions: at least 4.5:1 regardless of nominal text size;
- color is not the sole indicator of meaning; and
- important supplied imagery retains meaningful descriptions/provenance.

The audit will compute contrast from rendered or resolved foreground and
background colors, not merely compare each color against White.

Automatic correction is permitted only when semantic intent is unambiguous:

- Azure text on a light canvas may become AA Azure.
- Green text on a light canvas may become AA Green.
- Text may switch between approved Black, White, Dark Blue, or Dark Gray when
  the intended light/dark surface is clear.

If no unambiguous approved correction passes, the audit blocks final output and
reports the element and measured ratio.

## Apply workflow

`scripts/apply-brand.mjs` will:

1. Resolve the target project and detect the active production format.
2. Copy approved assets into a project-local brand/media directory.
3. Copy the approved bumper pair and record their default intro/outro roles.
4. Generate tool adapters from canonical `tokens.json`.
5. Create `frame.md` when none exists.
6. If `frame.md` exists, update only the normative brand fields while
   preserving project-specific narrative and composition guidance.
7. Save a one-time project-local backup before changing an existing spec.
8. Record the applied brand version and asset checksums.
9. Print a concise summary of changes and the next audit command.

The operation will support a dry-run mode. Writes will be atomic, and repeating
the operation with the same brand version will be idempotent.

### Generated adapters

- **HyperFrames:** project `frame.md` plus local logo/avatar assets.
- **Video workflows:** project-local intro/outro bumpers plus their role
  assignments.
- **Web/browser compositions:** CSS custom properties in `tokens.css`.
- **Generic tools:** project-local `tokens.json`.
- **FFmpeg and native renderers:** the manifest supplies exact hex values,
  resolved font family, and local asset paths; renderer-specific command
  syntax remains with the production skill.

## Audit workflow

`scripts/audit-brand.mjs` will support source and final-output gates.

### Source audit

Where the format allows deterministic inspection, check:

- declared font families;
- raw and resolved colors;
- border radii on rectangular containers;
- asset hashes;
- bumper role assignments and canonical media properties;
- aspect-ratio changes to approved logos;
- contrast of resolved text/background pairs;
- applied brand and adapter versions; and
- presence of a light UI capture preference or documented exception.

### Visual audit

For rendered video work, sample representative frames and inspect:

- actual font resolution;
- logo integrity and legibility;
- contrast after compositing;
- screenshot treatment;
- gradient restraint;
- composition density;
- accent-color rationing; and
- safe margins for captions and lower thirds.

Judgment-based checks remain warnings unless they expose one of the three
critical failures.

### Report

The audit returns both human-readable Markdown and structured JSON:

```text
Brand audit: PASS | PASS WITH WARNINGS | BLOCKED
Corrected: <count>
Warnings: <count>
Blockers: <count>
```

Each finding includes:

- severity;
- rule identifier;
- file/frame/element location when available;
- observed value;
- expected value or approved alternatives;
- whether a correction was applied; and
- a short remediation.

A nonzero exit status is reserved for `BLOCKED`.

## Enforcement matrix

| Condition                                                      | Default action                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| Non-Arial font declaration                                     | Replace with Arial when editable                                 |
| Arial absent during editing/preview                            | Warn and use preview fallback                                    |
| Arial absent at final render                                   | Block                                                            |
| Raw Azure/Green used as failing text color                     | Replace with its AA alternative                                  |
| Other contrast failure with an unambiguous approved correction | Correct                                                          |
| Contrast failure without an unambiguous correction             | Block                                                            |
| Rounded rectangular container                                  | Set radius to zero when editable                                 |
| Pill caption/lower third                                       | Replace with square treatment when deterministic; otherwise warn |
| Title casing is clearly all-title-case                         | Suggest/correct sentence case while preserving proper nouns      |
| Ambiguous casing involving product names/acronyms              | Warn for review                                                  |
| Approved logo, unchanged                                       | Pass                                                             |
| Known outdated logo checksum                                   | Block                                                            |
| Approved logo recolored, cropped, distorted, or masked         | Block                                                            |
| Unknown logo-like asset                                        | Block pending provenance                                         |
| Approved bumper pair with correct roles                        | Pass                                                             |
| Bumpers supported and no explicit opt-out                      | Apply light intro and dark outro                                 |
| Explicit bumper opt-out                                        | Pass and preserve the opt-out                                    |
| Current bumpers swapped between intro/outro roles              | Correct the assignments                                          |
| Current bumper source modified or re-encoded                   | Replace with the canonical source copy                           |
| Legacy bumper checksum                                         | Block                                                            |
| Non-16:9 output                                                | Pad proportionally; never crop the bumper artwork                |
| Dark UI capture with known light alternative                   | Warn and request/use light capture                               |
| Dark UI capture with no light alternative                      | Warn; permit light outer treatment                               |
| Heavy/repeated gradients                                       | Warn                                                             |
| Unapproved decorative color                                    | Map when semantically obvious; otherwise warn                    |
| Forward-looking information                                    | Warn for disclaimer/legal treatment                              |

## Skill verification

Skill authoring will follow RED–GREEN–REFACTOR using isolated agents.

### Baseline scenarios without the skill

Run fresh agents against at least these scenarios and record their outputs:

1. Build a Tanzu lower third using an existing rounded-pill template with
   Inter and bright Green text on White.
2. Build an outro from an outdated Tanzu bug and recolor it to match a scene.
3. Render on a host where Arial is missing but Helvetica is available.
4. Place a supplied dark-mode product screenshot into an otherwise light
   Tanzu frame.
5. Create a dense process diagram using multiple gradients and all accent
   colors.
6. Use the legacy 10-second bumper because it already has an audio track.

Expected baseline failures include incorrect font choice, rounded geometry,
contrast failure, logo alteration, silent fallback, over-decoration, and use of
the obsolete bumper.

### Green scenarios with the skill

Repeat the same scenarios with `tanzu-brand` loaded. The agent must:

- use Arial and square geometry;
- switch text Green to AA Green when required;
- block the outdated or altered logo;
- block final rendering when Arial is unresolved;
- warn rather than fabricate a light screenshot; and
- simplify or warn about excessive gradients and accent use;
- apply the current light intro and dark outro; and
- block the legacy bumper.

### Refactor scenarios

Probe likely loopholes:

- “The logo is very small, so recoloring will not be noticeable.”
- “Helvetica is metrically close enough for the deadline.”
- “The caption pill belongs to the video template, so brand geometry should
  not apply.”
- “The gradient uses only approved colors, so unlimited use is compliant.”
- “The screenshot came from the user, so dark-mode guidance can be ignored.”

Update the skill only in response to observed failures. Re-run until the
expected behavior is stable.

### Deterministic tests

Implementation tests will cover:

- schema validation and exact raw tokens;
- token-to-CSS and token-to-`frame.md` generation;
- idempotent application and preservation of project-specific prose;
- backup behavior for an existing `frame.md`;
- contrast calculations and AA substitutions;
- asset allow/deny hashes;
- bumper media metadata, role assignment, opt-out, and legacy-video denial;
- logo aspect-ratio checks;
- font-resolution pass/fail behavior;
- report severity and exit status; and
- stale adapter/version detection.

## Installation and versioning

- The source skill is versioned in this repository.
- The installed copy records `brandVersion: "2026.02"` and the source commit.
- `apply-brand` records the applied brand version in each project.
- Updating the skill does not silently rewrite existing projects.
- A future explicit update operation will show the token and asset delta before
  applying it.

## Non-goals

- Importing the PowerPoint through the VPA Brand wizard.
- Changing VPA's current Brand Library data model or routes.
- Packaging or redistributing proprietary font binaries.
- Packaging VPA music, sonic-logo, or legacy bumper files.
- Reconstructing vector master logos from raster images.
- Defining new animation timing, easing, or transition rules.
- Forcing slide-specific point sizes or layouts into videos.
- Automatically adding legal disclaimer text to video.
- Treating every font/color found anywhere in the deck as approved.
- Publishing the deck-extracted assets as a public brand kit.

## Implementation boundaries

The first implementation will create and verify the standalone skill only.
VPA wizard work, UI integration, managed brand updates, and master-asset
replacement remain separate follow-up projects.

## Open questions

None block implementation. A future authorized vector logo package can replace
the initial raster assets without changing the skill contract.

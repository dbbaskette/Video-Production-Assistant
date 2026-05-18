# Device Frame Assets

Frame assets used by the render pipeline to wrap recordings in device mockups.

## What's Here

```
device-frames/
├── manifest.json       # registry of every available frame
├── sources/            # hand-authored SVG sources (source of truth)
├── frames/             # rasterized PNGs consumed by the render pipeline
├── thumbnails/         # rasterized thumbnails consumed by the picker UI
└── README.md
```

## Manifest

`manifest.json` is read on server startup and exposed via `GET /api/frames`,
which populates the frame picker in the UI. Each entry specifies:

- A frame PNG (device chrome / bezel)
- A thumbnail PNG (small preview)
- Geometry: either a flat `inset` rectangle or a perspective `quad`

The zod schemas in `apps/server/src/services/frame/manifest.ts`
(`FlatFrameSchema` / `PerspectiveFrameSchema`, joined by a discriminated
union on `type`) are the truth — this README only covers conceptual
structure. Look at the schema for exact field definitions.

## Shipped Families

| Family   | Flat                | Perspective              |
|----------|---------------------|--------------------------|
| laptop   | `laptop-flat`       | `laptop-tilt-right`      |
| iphone   | `iphone-flat`       | `iphone-tilt-right`      |
| android  | `android-flat`      | `android-tilt-right`     |
| tablet   | `tablet-flat`       | `tablet-tilt-right`      |
| browser  | `browser-flat`      | `browser-tilt-right`     |

All ten frames are hand-authored SVG → PNG. The browser-chrome variants
draw a static URL pill reading `https://example.com/demo`; making that
per-scene editable is a follow-up (see [#29](https://github.com/dbbaskette/Video-Production-Assistant/issues/29)).

## Editing or Adding Frames

### Workflow

1. Edit / add an SVG under `sources/<id>.svg`. The viewBox sets the
   frame's pixel canvas — match `frameSize` in the manifest entry.
2. For flat frames: draw the bezel/chrome with the screen region cut
   out via `fill-rule="evenodd"` so the recording shows through.
3. For perspective frames: draw the bezel as a polygon outside the
   screen quad, with the screen quad punched out via `fill-rule="evenodd"`.
   The renderer warps the recording into the quad using ffmpeg's
   `perspective` filter — the SVG just provides chrome geometry.
4. Run the build script:
   ```bash
   ./scripts/render-frames.sh
   ```
   Requires `librsvg` (`brew install librsvg`). Outputs to `frames/` and
   `thumbnails/`.
5. Edit `manifest.json` — add or update the entry with the correct
   `inset` (flat) or `quad` (perspective) geometry matching the SVG.
6. Restart the server. Changes appear at `GET /api/frames` and in the
   FrameStylePicker.

### Flat frame manifest entry

```json
{
  "id": "laptop-flat",
  "family": "laptop",
  "variant": "flat",
  "displayName": "MacBook (flat)",
  "frame": "frames/laptop-flat.png",
  "thumbnail": "thumbnails/laptop-flat.png",
  "frameSize": { "w": 2560, "h": 1600 },
  "type": "flat",
  "inset": { "x": 80, "y": 80, "w": 2400, "h": 1400 }
}
```

`inset` is the rectangle in frame-pixel coordinates where the recording
lands. The renderer letterboxes recordings whose aspect ratio doesn't
match the inset, so chrome with rounded screen corners still works
cleanly (the opaque bezel masks the recording's hard corners).

### Perspective frame manifest entry

```json
{
  "id": "laptop-tilt-right",
  "family": "laptop",
  "variant": "tilt-right",
  "displayName": "MacBook (tilted right)",
  "frame": "frames/laptop-tilt-right.png",
  "thumbnail": "thumbnails/laptop-tilt-right.png",
  "frameSize": { "w": 2560, "h": 1600 },
  "type": "perspective",
  "quad": {
    "tl": { "x": 200, "y": 180 },
    "tr": { "x": 2400, "y": 100 },
    "br": { "x": 2400, "y": 1500 },
    "bl": { "x": 200, "y": 1420 }
  }
}
```

`quad` is the four screen corners in frame-pixel coordinates. **Note:**
when these corners flow into ffmpeg's `perspective` filter, they are
reordered to `tl → tr → bl → br`. The renderer (`buildPerspectiveFilter`)
handles this reordering; you just enter the corners in the manifest
order shown above (`tl, tr, br, bl`).

## Technical Notes

- The render pipeline's `buildPerspectiveFilter` uses a "scale-to-frame,
  no pre-pad" geometry: the recording is scaled to the full frame canvas
  before being warped into the quad. This means recorded video may bleed
  outside the screen quad. The device PNG must have opaque chrome
  covering everything outside the quad to mask this bleed cleanly. All
  shipped frames satisfy this.
- Background fill (`brand`, `transparent`, or a custom hex) is resolved
  by the render pipeline — the SVG does not own the background color.
  Just leave space outside the chrome transparent.
- Transparent backgrounds are explicitly disabled in v1 (mp4 lacks
  alpha). The picker shows the option; the renderer throws a clear error.
- Browser-chrome URL bar text is currently hard-coded in the SVG. Making
  it scene-editable is deferred (small new optional `Scene.frame_url`
  field + renderer text-overlay step).

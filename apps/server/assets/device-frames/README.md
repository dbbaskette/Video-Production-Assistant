# Device Frame Assets

Frame assets used by the render pipeline to wrap recordings in device mockups.

## What's Here

```
device-frames/
├── manifest.json       # registry of every available frame
├── sources/            # SVG sources for frames we hand-author (browser only)
├── frames/             # full-res PNGs consumed by the render pipeline
├── thumbnails/         # 160px-wide previews consumed by the picker UI
└── README.md
```

## Manifest

`manifest.json` is read on server startup and exposed via `GET /api/frames`,
which populates the frame picker in the UI. Each entry specifies:

- A frame PNG (device chrome / bezel with the screen area transparent)
- A thumbnail PNG (small preview)
- Geometry: a flat `inset` rectangle

The zod schemas in `apps/server/src/services/frame/manifest.ts`
(`FlatFrameSchema` / `PerspectiveFrameSchema`, joined by a discriminated
union on `type`) are the truth — this README only covers conceptual
structure. Look at the schema for exact field definitions.

## Shipped Frames

| Family   | Flat            | Source              |
|----------|-----------------|---------------------|
| laptop   | `laptop-flat`   | Apple MacBook Pro M5 16" mockup PNG |
| tablet   | `tablet-flat`   | Apple iPad Pro M5 13" Landscape mockup PNG |
| browser  | `browser-flat`  | Hand-authored SVG (`sources/browser-flat.svg`) |

The browser frame draws a static URL pill reading `https://example.com/demo`;
making that per-scene editable is a follow-up
(see [#29](https://github.com/dbbaskette/Video-Production-Assistant/issues/29)).

Tilted perspective variants were tried and dropped — hand-authored SVG
versions looked artificial and Apple does not ship angled mockups. If
they're needed later, the path is to source licensed photoreal angled
mockup PNGs and add `type: "perspective"` entries with a `quad` geometry.

## Editing or Adding Frames

### Adding a new frame from a vendor mockup PNG

1. Confirm the PNG has the screen area as alpha=0 (transparent). Most
   official vendor mockups (Apple Design Resources, etc.) are authored
   this way.
2. Measure the screen rectangle in PNG pixel coordinates. Scan the alpha
   channel with ffmpeg to find the bounds:
   ```bash
   ffmpeg -i frame.png -vf "alphaextract,crop=W:1:0:MID_Y" \
     -f rawvideo -pix_fmt gray - | python3 -c "
   import sys
   data = sys.stdin.buffer.read()
   prev = -1
   for i, b in enumerate(data):
       cur = 1 if b >= 128 else 0
       if cur != prev:
           print(f'x={i}: {(\"OPAQUE\" if cur else \"transparent\")}')
           prev = cur"
   ```
   Run once horizontally (`crop=W:1:0:Y`) and once vertically
   (`crop=1:H:X:0`). The middle transparent region is the screen.
3. Drop the PNG into `frames/<id>.png`. Generate a 160px-wide thumbnail
   into `thumbnails/<id>.png` (ffmpeg `scale=160:-1` works).
4. Add a manifest entry with the measured `inset`.
5. Restart the server.

### Editing the browser-flat SVG

`browser-flat` is the one frame still authored as SVG. Edit
`sources/browser-flat.svg`, then run:
```bash
./scripts/render-frames.sh
```
Requires `librsvg` (`brew install librsvg`). Outputs to `frames/` and
`thumbnails/`. Update `inset` in `manifest.json` if you change the chrome
height.

### Flat frame manifest entry

```json
{
  "id": "laptop-flat",
  "family": "laptop",
  "variant": "flat",
  "displayName": "MacBook (flat)",
  "frame": "frames/laptop-flat.png",
  "thumbnail": "thumbnails/laptop-flat.png",
  "frameSize": { "w": 4260, "h": 2840 },
  "type": "flat",
  "inset": { "x": 402, "y": 303, "w": 3456, "h": 2234 }
}
```

`inset` is the rectangle in frame-pixel coordinates where the recording
lands. The renderer letterboxes recordings whose aspect ratio doesn't
match the inset, so chrome with rounded screen corners still works
cleanly (the opaque bezel masks the recording's hard corners).

## Technical Notes

- Background fill (`brand`, `transparent`, or a custom hex) is resolved
  by the render pipeline — the frame PNG does not own the background
  color. Just leave space outside the chrome transparent.
- Transparent backgrounds are explicitly disabled in v1 (mp4 lacks
  alpha). The picker shows the option; the renderer throws a clear error.
- Browser-chrome URL bar text is currently hard-coded in the SVG. Making
  it scene-editable is deferred (small new optional `Scene.frame_url`
  field + renderer text-overlay step).
- The render pipeline's `buildPerspectiveFilter` is still in the codebase
  for future perspective frames but is not used by any shipped frame.

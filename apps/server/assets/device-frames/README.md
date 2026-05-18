# Device Frame Assets

This directory contains frame assets used by the render pipeline to wrap recordings in device mockups.

## What the Manifest Is

The `manifest.json` file at this path describes all available device-frame assets that the render pipeline can wrap a recording in. Each entry specifies:

- A frame PNG (the device chrome/bezel itself)
- A thumbnail PNG (small preview for the UI)
- Geometry to position the recording within the frame, via either:
  - A flat inset (rectangular region inside the frame PNG)
  - A perspective quad (four screen corners for 3D tilted frames)

The manifest is read by the server and exposed via `GET /api/frames`, which populates the frame picker in the UI.

## Schema Reference

Frame entries in `manifest.json` conform to one of two TypeScript schemas defined in `apps/server/src/services/frame/manifest.ts`:

- **`FlatFrameSchema`** — for frames with a flat, axis-aligned screen region. Includes an `inset` rectangle.
- **`PerspectiveFrameSchema`** — for frames with a tilted or 3D-rotated screen region. Includes a `quad` (four corner points).

See those schemas in the source code for full property details; this README covers the conceptual structure and how to add frames.

## v1 Shipping Assets

Currently, v1 ships only **`laptop-flat`** as a reference asset. The frame PNG is a 1×1 placeholder; real design work is pending. See [#29](https://github.com/dbbaskette/Video-Production-Assistant/issues/29) for the design + manifest roadmap for the remaining device families (iPhone, Android, browser-chrome, tablet).

## Adding a New Frame

### 1. Create and prepare the frame assets

- **Frame PNG** — the device chrome/bezel. Save at `frames/<id>.png`. Recommend 2× to 3× the final output resolution to avoid upscaling artifacts.
- **Thumbnail PNG** — a small preview (~160×100 px) used in the FrameStylePicker UI. Save at `thumbnails/<id>.png`.

The frame PNG should have an opaque region outside the screen area (so that perspective distortion bleed gets masked cleanly).

### 2. Add an entry to `manifest.json`

Append a new object with the appropriate type and geometry:

#### For flat frames (axis-aligned screen)

```json
{
  "id": "device-id-flat",
  "label": "Device Name",
  "type": "flat",
  "thumbnail": "device-id-flat.png",
  "frame": "device-id-flat.png",
  "inset": {
    "x": 100,
    "y": 60,
    "w": 720,
    "h": 480
  }
}
```

The `inset` is a rectangle in **frame pixel coordinates** that describes where the recording should land:
- `x`, `y` — top-left corner of the recording region
- `w`, `h` — width and height of the recording region

#### For perspective frames (tilted screen)

```json
{
  "id": "device-id-perspective",
  "label": "Device Name (Tilted)",
  "type": "perspective",
  "thumbnail": "device-id-perspective.png",
  "frame": "device-id-perspective.png",
  "quad": {
    "tl": { "x": 120, "y": 80 },
    "tr": { "x": 840, "y": 70 },
    "br": { "x": 850, "y": 550 },
    "bl": { "x": 110, "y": 560 }
  }
}
```

The `quad` is four corners of the screen region in the frame PNG (in frame pixel coordinates):
- `tl` — top-left corner
- `tr` — top-right corner
- `br` — bottom-right corner
- `bl` — bottom-left corner

**Important:** When these corners are passed to ffmpeg's perspective filter, they are reordered to `tl→tr→bl→br`. The renderer handles this reordering for you; just enter the corners in the manifest order shown above.

### 3. Restart the server

The manifest is read on startup. Restart the server:

```bash
npm run dev
```

The new frame will appear in `GET /api/frames` and in the UI frame picker immediately.

## Remaining Device Families

Design and manifest entries for the following device families are tracked in [#29](https://github.com/dbbaskette/Video-Production-Assistant/issues/29):

- iPhone (flat + at least one perspective variant)
- Android phone (flat + at least one perspective variant)
- Browser chrome (flat + at least one perspective variant, with editable URL bar text deferred)
- Tablet (flat + at least one perspective variant)
- Mac laptop real design (upgrade from 1×1 placeholder + at least one perspective variant)

## Technical Notes

- The render pipeline uses the `buildPerspectiveFilter` function, which applies a "scale-to-frame, no pre-pad" geometry. This means recorded video may bleed slightly outside the perspective quad. The device frame PNG must have opaque chrome covering the entire area outside the screen region to mask this bleed cleanly.
- Adding a new frame requires only asset files and a manifest entry — no code changes are needed once the schema is in place.
- Thumbnails should not have transparency or distortion; they are displayed as-is in the picker UI.

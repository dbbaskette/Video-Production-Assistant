import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// ── Point and rectangle primitives ───────────────────────────────────────────

const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const InsetSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const QuadSchema = z.object({
  tl: PointSchema,
  tr: PointSchema,
  br: PointSchema,
  bl: PointSchema,
});

const FrameSizeSchema = z.object({
  w: z.number().positive(),
  h: z.number().positive(),
});

// ── Common fields shared by all frame entries ─────────────────────────────────

const FrameEntryBaseSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  variant: z.string().min(1),
  displayName: z.string().min(1),
  frame: z.string().min(1),
  thumbnail: z.string().min(1),
  frameSize: FrameSizeSchema,
});

// ── Discriminated union on type ───────────────────────────────────────────────

export const FlatFrameSchema = FrameEntryBaseSchema.extend({
  type: z.literal('flat'),
  inset: InsetSchema,
});
export type FlatFrame = z.infer<typeof FlatFrameSchema>;

export const PerspectiveFrameSchema = FrameEntryBaseSchema.extend({
  type: z.literal('perspective'),
  quad: QuadSchema,
});
export type PerspectiveFrame = z.infer<typeof PerspectiveFrameSchema>;

export const FrameEntrySchema = z.discriminatedUnion('type', [
  FlatFrameSchema,
  PerspectiveFrameSchema,
]);
export type FrameEntry = z.infer<typeof FrameEntrySchema>;

// ── Manifest schema ───────────────────────────────────────────────────────────

const FrameManifestSchema = z.object({
  version: z.literal(1),
  frames: z.array(FrameEntrySchema),
});
export type FrameManifest = z.infer<typeof FrameManifestSchema>;

// ── Module-level cache keyed by resolved directory path ───────────────────────

const cache = new Map<string, FrameManifest>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load and validate the device-frame manifest from `<assetsDir>/manifest.json`.
 * Results are cached in memory so repeated calls with the same directory are free.
 */
export async function loadFrameManifest(assetsDir: string): Promise<FrameManifest> {
  const key = resolve(assetsDir);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const manifestPath = resolve(key, 'manifest.json');
  const text = await readFile(manifestPath, 'utf-8');
  const raw: unknown = JSON.parse(text);
  const parsed = FrameManifestSchema.parse(raw);
  cache.set(key, parsed);
  return parsed;
}

/**
 * Look up a frame entry by its `id` field.
 * Returns `undefined` if no entry with that id exists.
 */
export function getFrame(manifest: FrameManifest, id: string): FrameEntry | undefined {
  return manifest.frames.find((f) => f.id === id);
}

/**
 * Returns the absolute path to the bundled device-frames assets directory.
 * Located at `apps/server/assets/device-frames` relative to this module.
 */
export function defaultAssetsDir(): string {
  // __dirname equivalent in ESM:  import.meta.dirname (Node 21.2+)
  // This file lives at src/services/frame/manifest.ts
  // The assets directory is at   assets/device-frames (two levels up from src/)
  return resolve(import.meta.dirname, '../../../assets/device-frames');
}

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../../lib/fs-atomic.js';

export const RenderManifestSchema = z.object({
  version: z.literal(1),
  completedAt: z.string().datetime(),
  output: z.object({ path: z.string(), sizeBytes: z.number().int().nonnegative(), durationSec: z.number().nonnegative(), sceneCount: z.number().int().nonnegative() }),
  options: z.unknown(),
  fingerprint: z.string().length(64),
});
export type RenderManifest = z.infer<typeof RenderManifestSchema>;

export async function readRenderManifest(projectPath: string): Promise<RenderManifest | null> {
  try {
    const value = JSON.parse(await readFile(join(projectPath, 'renders', 'render-manifest.json'), 'utf8'));
    return RenderManifestSchema.parse(value);
  } catch {
    return null;
  }
}

export async function writeRenderManifest(projectPath: string, input: Omit<RenderManifest, 'version'>): Promise<void> {
  await atomicWriteFile(join(projectPath, 'renders', 'render-manifest.json'), JSON.stringify({ version: 1, ...input }, null, 2));
}

export async function getFinalOutputInfo(projectPath: string) {
  try {
    const info = await stat(join(projectPath, 'renders', 'final.mp4'));
    return { sizeBytes: info.size, modifiedAt: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

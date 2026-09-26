import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../../lib/fs-atomic.js';

const LegacyRenderManifestSchema = z.object({
  version: z.literal(1),
  completedAt: z.string().datetime(),
  output: z.object({ path: z.string(), sizeBytes: z.number().int().nonnegative(), durationSec: z.number().nonnegative(), sceneCount: z.number().int().nonnegative() }),
  options: z.unknown(),
  fingerprint: z.string().length(64),
});
export const RenderManifestSchema = z.object({
  version: z.literal(2),
  artifactId: z.string().min(1),
  jobId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  inputFingerprint: z.string().length(64),
  sourceChecksums: z.record(z.string(), z.string()),
  rendererVersion: z.string().min(1),
  fonts: z.array(z.string()),
  completedAt: z.string().datetime(),
  output: z.object({
    path: z.string(), sizeBytes: z.number().int().nonnegative(), durationSec: z.number().nonnegative(), sceneCount: z.number().int().nonnegative(),
    width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), fps: z.number().positive().optional(),
    videoCodec: z.string().optional(), audioCodec: z.string().optional(),
  }),
  options: z.unknown(),
  fingerprint: z.string().length(64),
});
export type RenderManifest = z.infer<typeof RenderManifestSchema>;
export type AnyRenderManifest = RenderManifest | z.infer<typeof LegacyRenderManifestSchema>;

export async function readRenderManifest(projectPath: string): Promise<AnyRenderManifest | null> {
  try {
    const value = JSON.parse(await readFile(join(projectPath, 'renders', 'render-manifest.json'), 'utf8'));
    return z.union([RenderManifestSchema, LegacyRenderManifestSchema]).parse(value);
  } catch {
    return null;
  }
}

export async function writeRenderManifest(projectPath: string, input: Omit<RenderManifest, 'version'>): Promise<void> {
  const value = { version: 2 as const, ...input };
  const manifests = join(projectPath, 'renders', 'manifests');
  await mkdir(manifests, { recursive: true });
  await atomicWriteFile(join(manifests, `${input.artifactId}.json`), JSON.stringify(value, null, 2));
  await atomicWriteFile(join(projectPath, 'renders', 'render-manifest.json'), JSON.stringify(value, null, 2));
}

export async function listRenderManifests(projectPath: string): Promise<RenderManifest[]> {
  const root = join(projectPath, 'renders', 'manifests');
  try {
    const values = await Promise.all((await readdir(root)).filter((name) => name.endsWith('.json')).map(async (name) => {
      try { return RenderManifestSchema.parse(JSON.parse(await readFile(join(root, name), 'utf8'))); } catch { return null; }
    }));
    return values.filter((value): value is RenderManifest => value !== null).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  } catch { return []; }
}

export async function getFinalOutputInfo(projectPath: string) {
  try {
    const manifest = await readRenderManifest(projectPath);
    const info = await stat(join(projectPath, manifest?.output.path ?? 'renders/final.mp4'));
    return { sizeBytes: info.size, modifiedAt: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

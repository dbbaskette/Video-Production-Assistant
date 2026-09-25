import { z } from 'zod';
import { isSafeProjectRelativePath } from './presentation.js';

export const AssetIdSchema = z.string().regex(/^asset_[a-f0-9]{64}$/);
export type AssetId = z.infer<typeof AssetIdSchema>;

export const AssetMediaKindSchema = z.enum(['video', 'image', 'audio']);
export type AssetMediaKind = z.infer<typeof AssetMediaKindSchema>;

export const AssetSourceRoleSchema = z.enum([
  'screen',
  'camera',
  'microphone',
  'system-audio',
  'narration',
  'music',
  'image',
]);
export type AssetSourceRole = z.infer<typeof AssetSourceRoleSchema>;

export const AssetPreparationSchema = z.object({
  status: z.enum(['pending', 'ready', 'failed']),
  thumbnail: z.string().refine(isSafeProjectRelativePath).optional(),
  proxy: z.string().refine(isSafeProjectRelativePath).optional(),
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(300),
  }).optional(),
  attempts: z.number().int().nonnegative().default(0),
  updated_at: z.string().datetime(),
});
export type AssetPreparation = z.infer<typeof AssetPreparationSchema>;

export const AssetSchema = z.object({
  id: AssetIdSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  original_name: z.string().min(1).max(255),
  source: z.string().refine(isSafeProjectRelativePath),
  origin: z.enum(['source', 'derived']).default('source'),
  derived_from: AssetIdSchema.optional(),
  media_kind: AssetMediaKindSchema,
  mime_type: z.string().min(1).max(100),
  size_bytes: z.number().int().nonnegative().max(2 * 1024 * 1024 * 1024),
  imported_at: z.string().datetime(),
  duration_sec: z.number().positive().max(20 * 60).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  timing_origin_ms: z.number().int().nonnegative().default(0),
  capture_session_id: z.string().uuid().optional(),
  source_role: AssetSourceRoleSchema.optional(),
  legacy_source: z.string().refine(isSafeProjectRelativePath).optional(),
  preparation: AssetPreparationSchema,
}).superRefine((asset, ctx) => {
  if (asset.origin === 'derived' && !asset.derived_from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['derived_from'], message: 'derived assets require a source asset id' });
  }
  if (asset.origin === 'source' && asset.derived_from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['derived_from'], message: 'source assets cannot name a derived source' });
  }
});
export type Asset = z.infer<typeof AssetSchema>;

export const AssetManifestSchema = z.object({
  version: z.literal(1),
  assets: z.array(AssetSchema),
}).superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  const checksums = new Set<string>();
  for (const [index, asset] of manifest.assets.entries()) {
    if (ids.has(asset.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['assets', index, 'id'], message: 'duplicate asset id' });
    }
    if (checksums.has(asset.checksum)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['assets', index, 'checksum'], message: 'duplicate asset checksum' });
    }
    ids.add(asset.id);
    checksums.add(asset.checksum);
  }
});
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export const AssetMappingSchema = z.object({
  sceneId: z.string().min(1),
  assetId: AssetIdSchema,
  role: AssetSourceRoleSchema.default('screen'),
  timingOriginMs: z.number().int().nonnegative().default(0),
});
export type AssetMapping = z.infer<typeof AssetMappingSchema>;

export const AssetMappingRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(120),
  mappings: z.array(AssetMappingSchema).min(1).max(200),
}).strict().superRefine((request, ctx) => {
  const targets = new Set<string>();
  for (const [index, mapping] of request.mappings.entries()) {
    const key = `${mapping.sceneId}\0${mapping.role}`;
    if (targets.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mappings', index],
        message: 'A scene source role may only be assigned once per request',
      });
    }
    targets.add(key);
  }
});
export type AssetMappingRequest = z.infer<typeof AssetMappingRequestSchema>;

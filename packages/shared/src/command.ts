import { z } from 'zod';
import { AssetIdSchema, AssetSourceRoleSchema } from './asset.js';
import { SceneSchema } from './storyboard.js';

const AssignAssetCommandSchema = z.object({
  type: z.literal('scene.assign-asset'),
  sceneId: z.string().min(1),
  assetId: AssetIdSchema,
  role: AssetSourceRoleSchema.default('screen'),
  timingOriginMs: z.number().int().nonnegative().default(0),
}).strict();

const PutSceneCommandSchema = z.object({
  type: z.literal('scene.put'),
  scene: SceneSchema,
}).strict();

const AddSceneCommandSchema = z.object({
  type: z.literal('scene.add'),
  scene: SceneSchema,
  index: z.number().int().nonnegative().optional(),
}).strict();

const DeleteSceneCommandSchema = z.object({
  type: z.literal('scene.delete'),
  sceneId: z.string().min(1),
}).strict();

const ReorderScenesCommandSchema = z.object({
  type: z.literal('scene.reorder'),
  sceneIds: z.array(z.string().min(1)).max(500),
}).strict();

const PatchProjectCommandSchema = z.object({
  type: z.literal('project.patch'),
  patch: z.object({
    objective: z.string().optional(),
    audience: z.string().optional(),
  }).strict(),
}).strict();

const RestoreRevisionCommandSchema = z.object({
  type: z.literal('revision.restore'),
  revision: z.number().int().nonnegative(),
}).strict();

export const ProjectCommandSchema = z.discriminatedUnion('type', [
  AssignAssetCommandSchema,
  PutSceneCommandSchema,
  AddSceneCommandSchema,
  DeleteSceneCommandSchema,
  ReorderScenesCommandSchema,
  PatchProjectCommandSchema,
  RestoreRevisionCommandSchema,
]);
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;

export const ProjectCommandBatchSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(120),
  targetState: z.enum(['draft', 'accepted']).optional(),
  commands: z.array(ProjectCommandSchema).min(1).max(200),
}).strict().superRefine((batch, ctx) => {
  const restores = batch.commands.filter((command) => command.type === 'revision.restore');
  if (restores.length > 0 && batch.commands.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['commands'],
      message: 'revision.restore must be the only command in a batch',
    });
  }
});
export type ProjectCommandBatch = z.infer<typeof ProjectCommandBatchSchema>;

export const ProjectCommandResultSchema = z.object({
  projectId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  previousRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string(),
  applied: z.number().int().positive(),
  state: z.enum(['draft', 'accepted']),
  restoredFrom: z.number().int().nonnegative().optional(),
});
export type ProjectCommandResult = z.infer<typeof ProjectCommandResultSchema>;

export const ProjectRevisionSchema = z.object({
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  idempotencyKey: z.string().optional(),
  commandTypes: z.array(z.string()),
  state: z.enum(['draft', 'accepted']).default('draft'),
  restoredFrom: z.number().int().nonnegative().optional(),
});
export type ProjectRevision = z.infer<typeof ProjectRevisionSchema>;

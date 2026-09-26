import { z } from 'zod';
import { ProjectModelRoutingSchema } from './model-routing.js';

export const ProductionBriefSchema = z.object({
  version: z.literal(1).default(1),
  purpose: z.string().trim().min(1).max(2_000).default('Explain the product clearly.'),
  audience: z.string().trim().min(1).max(1_000).default('General product users'),
  target_duration_sec: z.number().int().min(15).max(3_600).default(180),
  aspect_ratio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
  tone: z.enum(['clear', 'conversational', 'energetic', 'executive', 'educational']).default('clear'),
  brand: z.object({ name: z.string().trim().min(1).max(120), primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional() }).nullable().default(null),
}).strict();
export type ProductionBrief = z.infer<typeof ProductionBriefSchema>;
export const DEFAULT_PRODUCTION_BRIEF: ProductionBrief = ProductionBriefSchema.parse({});

/** Project metadata stored in <project root>/project.yaml */
export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/, 'name must be alphanumeric with - or _'),
  path: z.string().min(1), // absolute filesystem path
  created: z.string().datetime(),
  objective: z.string().optional(),
  audience: z.string().optional(),
  production_brief: ProductionBriefSchema.optional(),
  brand: z.object({
    id: z.string(),
    applied_version: z.number().int().positive(),
  }).nullable().default(null),
  model_routing: ProjectModelRoutingSchema.optional().default({}),
});
export type Project = z.infer<typeof ProjectSchema>;

/** Tracker entry in ~/.vpa/projects.json (the on-disk shape; `missing` is
 *  derived at list-time and only present in API responses). */
export const ProjectTrackerEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  path: z.string(),
  lastOpened: z.string().datetime().nullable(),
  /** True when the project's directory no longer exists on disk. Set by the
   *  server when listing; not stored in projects.json. */
  missing: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type ProjectTrackerEntry = z.infer<typeof ProjectTrackerEntrySchema>;

export const ProjectTrackerSchema = z.object({
  version: z.literal(1),
  projects: z.array(ProjectTrackerEntrySchema),
});
export type ProjectTracker = z.infer<typeof ProjectTrackerSchema>;

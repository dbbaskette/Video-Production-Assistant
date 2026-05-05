import { z } from 'zod';

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
  brand: z.object({
    id: z.string(),
    applied_version: z.number().int().positive(),
  }).nullable().default(null),
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
});
export type ProjectTrackerEntry = z.infer<typeof ProjectTrackerEntrySchema>;

export const ProjectTrackerSchema = z.object({
  version: z.literal(1),
  projects: z.array(ProjectTrackerEntrySchema),
});
export type ProjectTracker = z.infer<typeof ProjectTrackerSchema>;

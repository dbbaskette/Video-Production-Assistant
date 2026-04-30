import { z } from 'zod';
import { ProjectSchema, ProjectTrackerEntrySchema } from './project.js';

export const CreateProjectRequestSchema = z.object({
  name: ProjectSchema.shape.name,
  /** Absolute path to the parent directory; project will be created at <parent>/<name>. Optional — server uses VPA_PROJECTS_DEFAULT if omitted. */
  parentDir: z.string().optional(),
  objective: z.string().optional(),
  audience: z.string().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ImportProjectRequestSchema = z.object({
  /** Absolute path to an existing project root (must contain project.yaml). */
  path: z.string().min(1),
});
export type ImportProjectRequest = z.infer<typeof ImportProjectRequestSchema>;

export const ListProjectsResponseSchema = z.object({
  projects: z.array(ProjectTrackerEntrySchema),
});
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;

export const ProjectResponseSchema = ProjectSchema;
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

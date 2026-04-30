/// <reference types="vite/client" />
import {
  ProjectSchema,
  ListProjectsResponseSchema,
  type CreateProjectRequest,
  type ImportProjectRequest,
  type ListProjectsResponse,
  type Project,
} from '@vpa/shared';

const BASE = import.meta.env.VITE_VPA_API_BASE ?? 'http://localhost:3000';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message =
      (json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
        ? json.error
        : null) ?? `HTTP ${res.status}`;
    throw new ApiError(message, res.status, json);
  }
  return json as T;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public payload: unknown) {
    super(message);
  }
}

export const api = {
  async listProjects(): Promise<ListProjectsResponse> {
    const data = await request<unknown>('GET', '/api/projects');
    return ListProjectsResponseSchema.parse(data);
  },
  async createProject(input: CreateProjectRequest): Promise<Project> {
    const data = await request<unknown>('POST', '/api/projects', input);
    return ProjectSchema.parse(data);
  },
  async importProject(input: ImportProjectRequest): Promise<Project> {
    const data = await request<unknown>('POST', '/api/projects/import', input);
    return ProjectSchema.parse(data);
  },
  async getDefaults(): Promise<{ projectsDefault: string }> {
    return request('GET', '/api/config/defaults');
  },
};

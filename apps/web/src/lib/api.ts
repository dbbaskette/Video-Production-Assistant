/// <reference types="vite/client" />
import {
  ProjectSchema,
  ListProjectsResponseSchema,
  type CreateProjectRequest,
  type ImportProjectRequest,
  type ListProjectsResponse,
  type Project,
  type BrandRegistry,
  type BrandWithDoc,
  type DesignMdFrontMatter,
  type Job,
} from '@vpa/shared';

export const BASE = import.meta.env.VITE_VPA_API_BASE ?? 'http://localhost:3000';

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

export const brandsApi = {
  async list(): Promise<BrandRegistry> {
    return request<BrandRegistry>('GET', '/api/brands');
  },
  async detail(slug: string): Promise<BrandWithDoc> {
    return request<BrandWithDoc>('GET', `/api/brands/${slug}`);
  },
  async create(form: FormData): Promise<{ job_id: string; slug: string }> {
    const res = await fetch(`${BASE}/api/brands`, { method: 'POST', body: form });
    if (!res.ok) throw new ApiError(`Create failed: ${res.status}`, res.status, await res.json().catch(() => null));
    return res.json();
  },
  async generate(slug: string, frontMatter: DesignMdFrontMatter): Promise<{ job_id: string }> {
    return request('POST', `/api/brands/${slug}/generate`, { front_matter: frontMatter });
  },
  async setDefault(slug: string, isDefault: boolean): Promise<BrandWithDoc> {
    return request('PUT', `/api/brands/${slug}`, { is_default: isDefault });
  },
  async fork(slug: string, name: string): Promise<BrandWithDoc> {
    return request('POST', `/api/brands/${slug}/fork`, { name });
  },
  async regenerate(slug: string): Promise<{ job_id: string }> {
    return request('POST', `/api/brands/${slug}/regenerate`);
  },
  async deleteBrand(slug: string, force = false): Promise<void> {
    await request('DELETE', `/api/brands/${slug}${force ? '?force=true' : ''}`);
  },
  downloadUrl(slug: string): string {
    return `${BASE}/api/brands/${slug}/download`;
  },
};

export const jobsApi = {
  async get(id: string): Promise<Job> {
    return request<Job>('GET', `/api/jobs/${id}`);
  },
  stream(id: string, onEvent: (event: { type: string; data?: unknown }) => void): () => void {
    const es = new EventSource(`${BASE}/api/jobs/${id}/stream`);
    const handler = (e: MessageEvent) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* ignore parse errors */ }
    };
    es.onmessage = handler;
    for (const evt of ['persisted', 'extracting', 'extracted', 'extracting-tokens', 'tokens-ready', 'writing-rationale', 'done', 'error']) {
      es.addEventListener(evt, handler);
    }
    return () => es.close();
  },
};

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
  type Storyboard,
  type Scene,
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
  async getProject(id: string): Promise<Project> {
    const data = await request<unknown>('GET', `/api/projects/${id}`);
    return ProjectSchema.parse(data);
  },
  async setProjectBrand(
    id: string,
    brand: { id: string; applied_version: number } | null,
  ): Promise<Project> {
    const data = await request<unknown>('PUT', `/api/projects/${id}/brand`, { brand });
    return ProjectSchema.parse(data);
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
  async uploadAsset(slug: string, field: 'primary' | 'mono' | 'other', file: File): Promise<{ path: string }> {
    const form = new FormData();
    form.append('field', field);
    form.append('file', file);
    const res = await fetch(`${BASE}/api/brands/${slug}/assets`, { method: 'POST', body: form });
    if (!res.ok) throw new ApiError(`Upload failed: ${res.status}`, res.status, await res.json().catch(() => null));
    return res.json();
  },
  assetUrl(slug: string, relativePath: string): string {
    // relativePath is "assets/filename.png" — extract just the filename
    const filename = relativePath.replace(/^assets\//, '');
    return `${BASE}/api/brands/${slug}/assets/${encodeURIComponent(filename)}`;
  },
};

export interface IdeationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  scenes?: Scene[];
  timestamp: string;
}

export interface IdeationState {
  projectId: string;
  messages: IdeationMessage[];
  proposedScenes: Scene[];
}

export const storyboardApi = {
  async get(projectId: string): Promise<Storyboard | null> {
    try {
      return await request<Storyboard>('GET', `/api/projects/${projectId}/storyboard`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },
  async save(projectId: string, storyboard: Storyboard): Promise<Storyboard> {
    return request<Storyboard>('PUT', `/api/projects/${projectId}/storyboard`, storyboard);
  },
  async addScene(projectId: string, scene: Partial<Scene> & { name: string; description: string }): Promise<Storyboard> {
    return request<Storyboard>('POST', `/api/projects/${projectId}/storyboard/scenes`, scene);
  },
  async updateScene(projectId: string, sceneId: string, patch: Partial<Scene>): Promise<Storyboard> {
    return request<Storyboard>('PUT', `/api/projects/${projectId}/storyboard/scenes/${sceneId}`, patch);
  },
  async removeScene(projectId: string, sceneId: string): Promise<Storyboard> {
    return request<Storyboard>('DELETE', `/api/projects/${projectId}/storyboard/scenes/${sceneId}`);
  },
  async reorderScenes(projectId: string, orderedIds: string[]): Promise<Storyboard> {
    return request<Storyboard>('PUT', `/api/projects/${projectId}/storyboard/reorder`, { orderedIds });
  },
};

export const ideationApi = {
  async getSession(projectId: string): Promise<IdeationState> {
    return request<IdeationState>('GET', `/api/projects/${projectId}/ideation`);
  },
  async sendMessage(projectId: string, content: string): Promise<IdeationMessage> {
    return request<IdeationMessage>('POST', `/api/projects/${projectId}/ideation/message`, { content });
  },
  async accept(projectId: string): Promise<Storyboard> {
    return request<Storyboard>('POST', `/api/projects/${projectId}/ideation/accept`);
  },
};

export interface VideoMetadata {
  duration_sec: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
  size_bytes: number;
}

export interface IngestResult {
  sceneId: string;
  relativePath: string;
  metadata: VideoMetadata;
}

export const recordingsApi = {
  async uploadForScene(projectId: string, sceneId: string, file: File): Promise<IngestResult> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${BASE}/api/projects/${projectId}/scenes/${sceneId}/recording`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new ApiError(json?.error ?? `Upload failed: ${res.status}`, res.status, json);
    }
    return res.json();
  },

  async uploadBulk(projectId: string, files: File[]): Promise<{ results: IngestResult[]; assignedCount: number; totalScenes: number }> {
    const form = new FormData();
    files.forEach((f, i) => form.append(`file${i}`, f));
    const res = await fetch(`${BASE}/api/projects/${projectId}/recordings/bulk`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new ApiError(json?.error ?? `Upload failed: ${res.status}`, res.status, json);
    }
    return res.json();
  },

  async getMetadata(projectId: string, sceneId: string): Promise<VideoMetadata> {
    return request<VideoMetadata>('GET', `/api/projects/${projectId}/scenes/${sceneId}/recording/metadata`);
  },

  async generateStoryboard(projectId: string, files: File[]): Promise<Storyboard> {
    const form = new FormData();
    files.forEach((f, i) => form.append(`file${i}`, f));
    const res = await fetch(`${BASE}/api/projects/${projectId}/recordings/generate-storyboard`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new ApiError(json?.error ?? `Upload failed: ${res.status}`, res.status, json);
    }
    return res.json();
  },

  async proposeSplit(projectId: string, file: File): Promise<{ boundaries: SceneBoundary[]; sourceFile: string; metadata: VideoMetadata }> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${BASE}/api/projects/${projectId}/recordings/propose-split`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      throw new ApiError(json?.error ?? `Propose split failed: ${res.status}`, res.status, json);
    }
    return res.json();
  },

  async executeSplit(projectId: string, boundaries: SceneBoundary[]): Promise<Storyboard> {
    return request<Storyboard>('POST', `/api/projects/${projectId}/recordings/execute-split`, { boundaries });
  },
};

export interface ScriptState {
  sceneId: string;
  script: string | null;
  hasRecording: boolean;
}

export const scriptApi = {
  async get(projectId: string, sceneId: string): Promise<ScriptState> {
    return request<ScriptState>('GET', `/api/projects/${projectId}/scenes/${sceneId}/script`);
  },
  async generate(projectId: string, sceneId: string): Promise<{ sceneId: string; script: string }> {
    return request('POST', `/api/projects/${projectId}/scenes/${sceneId}/script/generate`);
  },
  async save(projectId: string, sceneId: string, script: string): Promise<{ sceneId: string; script: string }> {
    return request('PUT', `/api/projects/${projectId}/scenes/${sceneId}/script`, { script });
  },
};

export interface ReviewItem {
  sceneId: string;
  severity: 'info' | 'warn' | 'issue';
  category: string;
  message: string;
}

export interface ReviewResult {
  items: ReviewItem[];
  summary: { total: number; info: number; warn: number; issue: number };
  status: 'ok' | 'warnings' | 'issues' | null;
  reviewedAt: string | null;
}

export const qualityReviewApi = {
  async run(projectId: string): Promise<ReviewResult> {
    return request<ReviewResult>('POST', `/api/projects/${projectId}/review`);
  },
  async get(projectId: string): Promise<ReviewResult> {
    return request<ReviewResult>('GET', `/api/projects/${projectId}/review`);
  },
};

export interface LowerThirdItem {
  title: string;
  subtitle?: string;
  style: 'frosted' | 'solid' | 'minimal';
  in_sec: number;
  out_sec: number;
}

export const lowerThirdsApi = {
  async get(projectId: string, sceneId: string): Promise<{ sceneId: string; lowerThirds: LowerThirdItem[] }> {
    return request('GET', `/api/projects/${projectId}/scenes/${sceneId}/lower-thirds`);
  },
  async recommend(projectId: string, sceneId: string): Promise<{ sceneId: string; lowerThirds: LowerThirdItem[] }> {
    return request('POST', `/api/projects/${projectId}/scenes/${sceneId}/lower-thirds/recommend`);
  },
  async save(projectId: string, sceneId: string, lowerThirds: LowerThirdItem[]): Promise<{ sceneId: string; lowerThirds: LowerThirdItem[] }> {
    return request('PUT', `/api/projects/${projectId}/scenes/${sceneId}/lower-thirds`, { lowerThirds });
  },
};

export interface TtsVoiceInfo {
  id: string;
  name: string;
  description?: string;
}

export interface TtsEngineInfo {
  id: string;
  displayName: string;
  voices: TtsVoiceInfo[];
  supportedEmotives: string[];
}

export interface VoiceProfileInfo {
  id: string;
  name: string;
  engine: string;
  voice: string;
  speed: number;
  description?: string;
}

export interface NarrationChunkInfo {
  index: number;
  text: string;
  hasAudio: boolean;
  audio: string | null;
  durationSec: number | null;
  speaker?: string;   // "A" | "B" — dialog mode
}

export interface SpeakerConfig {
  engine: string;
  voice: string;
  speed: number;
  label?: string;
}

export interface NarrationState {
  sceneId: string;
  hasScript: boolean;
  hasAudio: boolean;
  audio: string | null;
  subtitles: { srt?: string; vtt?: string } | null;
  tts: { engine?: string; voice?: string; speed?: number } | null;
  timingCount: number;
  chunks: NarrationChunkInfo[];
  mode: 'monologue' | 'dialog';
  speakers: Record<string, SpeakerConfig>;
  monologueScript: string | null;
  dialogScript: string | null;
  dialogDirty: boolean;
  hasPreviousMonologue: boolean;
  hasPreviousDialog: boolean;
}

export interface NarrationResult {
  audioPath: string;
  srtPath: string;
  vttPath: string;
  durationSec: number;
  timingCount: number;
  unsupportedEmotives: string[];
}

export interface ChunkNarrationResult {
  chunkIndex: number;
  audioPath: string;
  durationSec: number;
  timingCount: number;
  unsupportedEmotives: string[];
}

export const ttsApi = {
  async listEngines(): Promise<TtsEngineInfo[]> {
    return request<TtsEngineInfo[]>('GET', '/api/tts/engines');
  },
};

export const voiceApi = {
  async list(): Promise<VoiceProfileInfo[]> {
    return request<VoiceProfileInfo[]>('GET', '/api/voices');
  },
  async create(profile: { name: string; engine: string; voice: string; speed?: number; description?: string }): Promise<VoiceProfileInfo> {
    return request<VoiceProfileInfo>('POST', '/api/voices', profile);
  },
  async remove(profileId: string): Promise<void> {
    await request('DELETE', `/api/voices/${profileId}`);
  },
};

export const narrationApi = {
  async get(projectId: string, sceneId: string): Promise<NarrationState> {
    return request<NarrationState>('GET', `/api/projects/${projectId}/scenes/${sceneId}/narration`);
  },
  async generate(
    projectId: string,
    sceneId: string,
    opts: { engine: string; voice: string; speed?: number },
  ): Promise<NarrationResult> {
    return request<NarrationResult>(
      'POST',
      `/api/projects/${projectId}/scenes/${sceneId}/narration/generate`,
      opts,
    );
  },
  async generateChunk(
    projectId: string,
    sceneId: string,
    opts: { chunkIndex: number; text: string; engine: string; voice: string; speed?: number },
  ): Promise<ChunkNarrationResult> {
    return request<ChunkNarrationResult>(
      'POST',
      `/api/projects/${projectId}/scenes/${sceneId}/narration/generate-chunk`,
      opts,
    );
  },
  async saveScript(
    projectId: string,
    sceneId: string,
    script: string,
    slot?: 'monologue' | 'dialog',
  ): Promise<{ saved: boolean; script: string }> {
    return request('PUT', `/api/projects/${projectId}/scenes/${sceneId}/narration/script`, { script, slot });
  },
  async restoreScript(
    projectId: string,
    sceneId: string,
    slot: 'monologue' | 'dialog',
  ): Promise<{ restored: boolean; script: string; slot: string }> {
    return request('POST', `/api/projects/${projectId}/scenes/${sceneId}/narration/restore`, { slot });
  },
  async saveMode(
    projectId: string,
    sceneId: string,
    mode: 'monologue' | 'dialog',
    speakers: Record<string, SpeakerConfig>,
  ): Promise<{ saved: boolean; needsConversion?: boolean; script?: string }> {
    return request('PUT', `/api/projects/${projectId}/scenes/${sceneId}/narration/mode`, { mode, speakers });
  },
  async saveSpeakerAssignments(
    projectId: string,
    sceneId: string,
    assignments: Array<{ index: number; speaker: string }>,
  ): Promise<{ saved: boolean }> {
    return request('PUT', `/api/projects/${projectId}/scenes/${sceneId}/narration/speakers`, { assignments });
  },
  async convertToDialog(
    projectId: string,
    sceneId: string,
  ): Promise<{ script: string; chunks: Array<{ index: number; text: string; speaker: string }> }> {
    return request('POST', `/api/projects/${projectId}/scenes/${sceneId}/narration/convert-dialog`);
  },
  audioUrl(projectId: string, sceneId: string): string {
    return `${BASE}/api/projects/${projectId}/scenes/${sceneId}/narration/audio`;
  },
  chunkAudioUrl(projectId: string, sceneId: string, chunkIndex: number): string {
    return `${BASE}/api/projects/${projectId}/scenes/${sceneId}/narration/chunk/${chunkIndex}/audio`;
  },
};

export interface VoiceCloneRef {
  filename: string;
  path: string;
  size: number;
  createdAt: string;
  transcript?: string;
}

export const voiceCloneApi = {
  async list(): Promise<VoiceCloneRef[]> {
    return request<VoiceCloneRef[]>('GET', '/api/voice-clone/list');
  },
  async upload(file: File): Promise<{ path: string; filename: string; size: number }> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${BASE}/api/voice-clone/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);
    return res.json();
  },
  async saveTranscript(filename: string, transcript: string): Promise<{ saved: boolean }> {
    return request('PUT', `/api/voice-clone/${encodeURIComponent(filename)}/transcript`, { transcript });
  },
  async remove(filename: string): Promise<void> {
    await request('DELETE', `/api/voice-clone/${encodeURIComponent(filename)}`);
  },
  async getScript(): Promise<{ script: string; instructions: string }> {
    return request('GET', '/api/voice-clone/script');
  },
};

export const overlayApi = {
  async render(projectId: string, sceneId: string): Promise<{ outputPath: string; durationSec: number }> {
    return request('POST', `/api/projects/${projectId}/scenes/${sceneId}/overlay/render`);
  },
  videoUrl(projectId: string, sceneId: string): string {
    return `${BASE}/api/projects/${projectId}/scenes/${sceneId}/overlay/video`;
  },
};

export interface SceneBoundary {
  start_sec: number;
  end_sec: number;
  suggested_name: string;
}

export interface ExportManifest {
  projectName: string;
  exportedAt: string;
  scenes: Array<{
    sceneId: string;
    sceneName: string;
    files: string[];
  }>;
  totalFiles: number;
}

export const exportApi = {
  async run(projectId: string): Promise<{ exportDir: string; manifest: ExportManifest }> {
    return request('POST', `/api/projects/${projectId}/export`);
  },
  async manifest(projectId: string): Promise<ExportManifest> {
    return request('GET', `/api/projects/${projectId}/export/manifest`);
  },
};

// ── Settings / Model Management ──────────────────────────────────
export interface ModelEntry {
  id: string;
  name: string;
  provider: 'fake' | 'gemini' | 'anthropic' | 'claude-code' | 'openai-compat';
  model: string;
  endpoint?: string;
  hasApiKey: boolean;
  active: boolean;
}

export interface ActiveModelInfo {
  id: string;
  name: string;
  provider: string;
  model: string;
  endpoint?: string;
  label: string;
}

export const settingsApi = {
  async listModels(): Promise<ModelEntry[]> {
    return request<ModelEntry[]>('GET', '/api/settings/models');
  },
  async addModel(entry: {
    id: string;
    name: string;
    provider: ModelEntry['provider'];
    model: string;
    endpoint?: string;
    apiKey?: string;
  }): Promise<ModelEntry> {
    return request<ModelEntry>('POST', '/api/settings/models', entry);
  },
  async updateModel(id: string, patch: {
    name?: string;
    model?: string;
    endpoint?: string;
    apiKey?: string;
  }): Promise<ModelEntry> {
    return request<ModelEntry>('PUT', `/api/settings/models/${id}`, patch);
  },
  async activateModel(id: string): Promise<ModelEntry> {
    return request<ModelEntry>('POST', `/api/settings/models/${id}/activate`);
  },
  async deleteModel(id: string): Promise<void> {
    await request('DELETE', `/api/settings/models/${id}`);
  },
  async getActiveModel(): Promise<ActiveModelInfo> {
    return request<ActiveModelInfo>('GET', '/api/settings/models/active');
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

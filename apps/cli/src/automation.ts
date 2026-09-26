import type {
  Expressiveness,
  Job,
  ProductionRecipe,
  ProductionRecipeInspection,
  ProjectCommandBatch,
  ProjectCommandResult,
} from '@vpa/shared';
import { VpaCliError, type HttpClient } from './client.js';

export interface NarrationEngine {
  id: string;
  displayName: string;
  ready: true;
  voices: Array<{ id: string; name: string; description?: string }>;
  supportedEmotives: string[];
  expressiveTags: string[];
  capabilities: {
    speed: { min: number; max: number; default: number };
    expressiveness: Expressiveness[];
    multiSpeaker: boolean;
    outputFormats: Array<'mp3' | 'wav'>;
    timings: 'estimated' | 'word' | 'none';
    subtitles: boolean;
    maxInputChars: number;
  };
}

export interface VoiceProfile {
  id: string;
  name: string;
  engine: string;
  voice: string;
  speed: number;
  description?: string;
}

export interface JobSubmission {
  jobId: string;
  status: string;
  reused?: boolean;
  [key: string]: unknown;
}

export interface StandaloneNarrationRequest {
  text: string;
  profile?: string;
  engine?: string;
  voice?: string;
  speed?: number;
  expressiveness?: Expressiveness;
}

export interface ProjectNarrationRequest {
  engine: string;
  voice: string;
  speed: number;
  expressiveness: Expressiveness;
  overwrite: boolean;
}

export interface ProjectRenderRequest {
  audioMode?: 'replace' | 'mix';
  burnSubtitles?: boolean;
  includeNarration?: boolean;
  includeLowerThirds?: boolean;
  musicTrackId?: string | null;
  musicVolumeDb?: number;
  musicScope?: 'full' | 'bumpers';
  useBrandBumpers?: boolean;
  useBrandMusic?: boolean;
  quality?: 'draft' | '1080p';
}

export class VpaAutomationClient {
  constructor(readonly http: HttpClient) {}

  listProjects(): Promise<unknown> {
    return this.http.json('GET', '/api/projects');
  }

  getProject(projectId: string): Promise<unknown> {
    return this.http.json('GET', `/api/projects/${encodeURIComponent(projectId)}`);
  }

  listNarrationEngines(): Promise<NarrationEngine[]> {
    return this.http.json('GET', '/api/tts/engines');
  }

  listNarrationProfiles(): Promise<VoiceProfile[]> {
    return this.http.json('GET', '/api/voices');
  }

  async listNarrationVoices(engineId?: string) {
    const engines = await this.listNarrationEngines();
    const voices = engines
      .filter((engine) => !engineId || engine.id === engineId)
      .flatMap((engine) => engine.voices.map((voice) => ({ engine: engine.id, ...voice })));
    if (engineId && voices.length === 0) {
      throw new VpaCliError(`Narration engine is unavailable or has no voices: ${engineId}`, 'invalid_request');
    }
    return voices;
  }

  async describeNarrationEngine(engineId: string): Promise<NarrationEngine> {
    const engine = (await this.listNarrationEngines()).find((candidate) => candidate.id === engineId);
    if (!engine) throw new VpaCliError(`Narration engine is unavailable: ${engineId}`, 'invalid_request');
    return engine;
  }

  createStandaloneNarration(input: StandaloneNarrationRequest, idempotencyKey?: string): Promise<unknown> {
    return idempotencyKey
      ? this.http.json('POST', '/api/tts/scratch', input, { headers: { 'Idempotency-Key': idempotencyKey } })
      : this.http.json('POST', '/api/tts/scratch', input);
  }

  startProjectNarration(
    projectId: string,
    input: ProjectNarrationRequest,
    idempotencyKey: string,
  ): Promise<JobSubmission> {
    return this.http.json(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/narration/generate-project`,
      input,
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  }

  getProjectRevision(projectId: string): Promise<unknown> {
    return this.http.json('GET', `/api/projects/${encodeURIComponent(projectId)}/revision`);
  }

  listProjectRevisions(projectId: string): Promise<unknown> {
    return this.http.json('GET', `/api/projects/${encodeURIComponent(projectId)}/revisions`);
  }

  executeProjectCommands(projectId: string, batch: ProjectCommandBatch): Promise<ProjectCommandResult> {
    return this.http.json('POST', `/api/projects/${encodeURIComponent(projectId)}/commands`, batch);
  }

  listJobs(filters: { active?: boolean; projectId?: string } = {}): Promise<{ jobs: Job[] }> {
    const query = new URLSearchParams();
    if (filters.active) query.set('active', '1');
    if (filters.projectId) query.set('projectId', filters.projectId);
    const suffix = query.size ? `?${query.toString()}` : '';
    return this.http.json('GET', `/api/jobs${suffix}`);
  }

  getJob(jobId: string): Promise<Job> {
    return this.http.json('GET', `/api/jobs/${encodeURIComponent(jobId)}`);
  }

  listProductionRecipes(): Promise<unknown> {
    return this.http.json('GET', '/api/production/recipes');
  }

  inspectProductionRecipe(projectId: string, recipe: ProductionRecipe): Promise<ProductionRecipeInspection> {
    return this.http.json('GET', `/api/projects/${encodeURIComponent(projectId)}/production/recipes/${encodeURIComponent(recipe)}/inspect`);
  }

  runProductionRecipe(projectId: string, recipe: ProductionRecipe, idempotencyKey: string): Promise<JobSubmission> {
    return this.http.json(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/production/recipes/${encodeURIComponent(recipe)}/run`,
      {},
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  }

  startProjectRender(
    projectId: string,
    input: ProjectRenderRequest,
    idempotencyKey: string,
  ): Promise<JobSubmission> {
    return this.http.json(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/render`,
      input,
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  }

  getRenderStatus(projectId: string): Promise<unknown> {
    return this.http.json('GET', `/api/projects/${encodeURIComponent(projectId)}/render/status`);
  }

  listFeedback(projectId: string): Promise<unknown> {
    return this.http.json('GET', `/api/projects/${encodeURIComponent(projectId)}/feedback`);
  }

  updateFeedback(
    projectId: string,
    noteId: string,
    action: 'claim' | 'resolve' | 'fail',
    body: { actor?: string; resolvingRevision?: number; resolution?: string; failure?: string },
  ): Promise<unknown> {
    return this.http.json(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/feedback/${encodeURIComponent(noteId)}/${action}`,
      body,
    );
  }
}

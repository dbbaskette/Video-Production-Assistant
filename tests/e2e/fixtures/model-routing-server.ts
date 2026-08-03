import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFakeLlm, type LlmClient } from '../../../apps/server/src/services/llm/index.js';
import type { ModelEntry } from '../../../apps/server/src/services/llm/model-registry.js';
import { createFakeProbe } from '../../../apps/server/src/services/recording/metadata.js';
import { VideoUnderstandingService } from '../../../apps/server/src/services/video-understanding/index.js';
import { buildServer } from '../../../apps/server/src/server.js';
import {
  MODEL_IDS,
  MODEL_ROUTING_E2E_CALLS,
  MODEL_ROUTING_E2E_HOME,
  MODEL_ROUTING_E2E_PROJECTS,
  type ModelRoutingE2eCall,
} from './model-routing-fixture.js';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fakeProbe = createFakeProbe();

async function record(call: ModelRoutingE2eCall): Promise<void> {
  await appendFile(MODEL_ROUTING_E2E_CALLS, `${JSON.stringify(call)}\n`, 'utf8');
}

async function prepareState(): Promise<void> {
  await Promise.all([
    rm(MODEL_ROUTING_E2E_HOME, { recursive: true, force: true }),
    rm(MODEL_ROUTING_E2E_PROJECTS, { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(MODEL_ROUTING_E2E_HOME, { recursive: true }),
    mkdir(MODEL_ROUTING_E2E_PROJECTS, { recursive: true }),
  ]);
  await writeFile(MODEL_ROUTING_E2E_CALLS, '', 'utf8');
  await writeFile(
    `${MODEL_ROUTING_E2E_HOME}/models.json`,
    `${JSON.stringify(
      {
        version: 2,
        models: [
          { id: 'fake', name: 'Fake utility model', provider: 'fake', model: 'fake' },
          {
            id: MODEL_IDS.primaryVideo,
            name: 'Gemini Vision Primary',
            provider: 'gemini',
            model: 'gemini-e2e-primary',
            apiKey: 'e2e-fake-key-primary',
          },
          {
            id: MODEL_IDS.secondaryVideo,
            name: 'Gemini Vision Secondary',
            provider: 'gemini',
            model: 'gemini-e2e-secondary',
            apiKey: 'e2e-fake-key-secondary',
          },
          {
            id: MODEL_IDS.writer,
            name: 'Codex Writer (fake)',
            provider: 'codex-cli',
            model: 'e2e-codex',
          },
          {
            id: MODEL_IDS.projectWriter,
            name: 'Claude Analyst (fake)',
            provider: 'claude-code',
            model: 'e2e-claude',
          },
          {
            id: MODEL_IDS.unavailableWriter,
            name: 'Unavailable Writer',
            provider: 'anthropic',
            model: 'e2e-unavailable',
          },
        ],
        assignments: {
          writing: 'fake',
          general: 'fake',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function fakeClientFactory(entry: ModelEntry): LlmClient {
  const fake = createFakeLlm();
  return {
    async complete(options) {
      await record({
        kind: 'text.complete',
        entryId: entry.id,
        provider: entry.provider,
        model: entry.model,
        userPrompt: options.userPrompt,
        systemPrompt: options.systemPrompt,
        responseFormat: options.responseFormat,
      });
      if (options.systemPrompt.toLowerCase().includes('script adapter')) {
        return {
          text:
            '[Speaker A] The routing panel makes each model responsibility explicit.\n\n' +
            '[Speaker B] And the recording stays with Gemini while the writer receives only the brief.',
        };
      }
      return fake.complete(options);
    },
  };
}

await prepareState();

const videoUnderstanding = new VideoUnderstandingService({
  workspaceRoot,
  probe: fakeProbe,
  now: () => new Date('2026-08-03T12:00:00.000Z'),
  warn: () => {},
  transport: {
    async uploadVideo(_apiKey, inputPath) {
      await record({ kind: 'video.upload', inputPath, fileName: 'files/e2e-video' });
      return {
        name: 'files/e2e-video',
        uri: 'https://generativelanguage.googleapis.com/files/e2e-video',
        mimeType: 'video/mp4',
        state: 'PROCESSING',
      };
    },
    async waitForFileActive(_apiKey, fileName) {
      await record({ kind: 'video.wait', fileName });
      return {
        name: fileName,
        uri: 'https://generativelanguage.googleapis.com/files/e2e-video',
        mimeType: 'video/mp4',
        state: 'ACTIVE',
      };
    },
    async generateWithVideo(input) {
      await record({
        kind: 'video.generate',
        model: input.model,
        userPrompt: input.userPrompt,
        systemPrompt: input.systemPrompt,
      });
      return JSON.stringify({
        visual_summary: 'The recording shows a deterministic product walkthrough.',
        segments: [
          {
            id: 'segment-e2e-1',
            start_sec: 1,
            end_sec: 8,
            screen_change: 'The dashboard opens and the routing panel becomes visible.',
            visible_labels: ['Model assignments'],
            on_screen_terms: ['Gemini', 'Codex'],
          },
        ],
        pacing_cues: [{ segment_id: 'segment-e2e-1', cue: 'Pause after the panel opens.' }],
        narration_cues: [{ segment_id: 'segment-e2e-1', cue: 'Explain the two-stage workflow.' }],
        lower_third_candidates: [
          {
            segment_id: 'segment-e2e-1',
            reason: 'The model routing panel is clearly visible.',
          },
        ],
      });
    },
    async deleteFile(_apiKey, fileName) {
      await record({ kind: 'video.delete', fileName });
      return true;
    },
  },
});

const { app, config } = await buildServer({
  config: {
    port: 3100,
    host: '127.0.0.1',
    vpaHome: MODEL_ROUTING_E2E_HOME,
    projectsDefault: MODEL_ROUTING_E2E_PROJECTS,
    webOrigin: 'http://127.0.0.1:5174',
    llm: { provider: 'fake' },
  },
  modelClientFactory: fakeClientFactory,
  cliReadinessProbe: async () => ({ ready: true }),
  videoUnderstanding,
  recordingProbe: fakeProbe,
});

await app.listen({ port: config.port, host: config.host });

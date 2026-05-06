import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { loadConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { projectsRoutes } from './routes/projects.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerBrandRoutes } from './routes/brands.js';
import { registerStoryboardRoutes } from './routes/storyboard.js';
import { registerIdeationRoutes } from './routes/ideation.js';
import { registerRecordingRoutes } from './routes/recordings.js';
import { registerScriptRoutes } from './routes/scripts.js';
import { registerNarrationRoutes } from './routes/narration.js';
import { registerVoiceCloneRoutes } from './routes/voice-clone.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerRenderRoutes } from './routes/render.js';
import { registerSceneRenderRoutes } from './routes/scene-render.js';
import { registerMusicRoutes } from './routes/music.js';
import { registerSourceDocsRoutes } from './routes/source-docs.js';
import { registerLowerThirdsRoutes } from './routes/lower-thirds.js';
import { registerQualityReviewRoutes } from './routes/quality-review.js';
import { registerOverlayRoutes } from './routes/overlay.js';
import { registerExportRoutes } from './routes/export.js';
import { ProjectStore } from './services/project/store.js';
import { resolve } from 'node:path';
import { brandPaths } from './services/brand/paths.js';
import { seedBrands } from './services/brand/seed.js';
import { createLlm, createLlmFromEntry } from './services/llm/factory.js';
import { SwappableLlm } from './services/llm/swappable.js';
import { RetryingLlm } from './services/llm/retrying.js';
import { ModelRegistry } from './services/llm/model-registry.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { IdeationManager } from './services/ideation/index.js';
import { TtsService, createFakeTtsProvider } from './services/tts/index.js';
import { createGeminiTtsProvider } from './services/tts/providers/gemini.js';
import { createXaiTtsProvider } from './services/tts/providers/xai.js';
import { createFishTtsProvider } from './services/tts/providers/fish.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export async function buildServer() {
  const config = loadConfig();
  const app = Fastify({ logger: { level: 'info' } });

  await app.register(cors, {
    origin: [config.webOrigin],
    credentials: false,
  });

  await app.register(multipart, {
    limits: {
      fileSize: 500 * 1024 * 1024, // 500 MB per file (video recordings)
      files: 10,
    },
  });

  const store = new ProjectStore({
    vpaHome: config.vpaHome,
    projectsDefault: config.projectsDefault,
  });

  const bPaths = brandPaths(config.vpaHome, config.vpaHome);

  // ── Seed built-in brands on first launch ────────────────────
  await seedBrands(bPaths, bPaths.registryFile);

  // ── Model registry (persisted in ~/.vpa/models.json) ──────────────
  const modelRegistry = new ModelRegistry(join(config.vpaHome, 'models.json'));
  await modelRegistry.load();

  const activeModel = modelRegistry.getActive();
  let innerLlm;
  let llmLabel: string;
  if (activeModel) {
    innerLlm = createLlmFromEntry(activeModel);
    llmLabel = `${activeModel.name} (${activeModel.provider}/${activeModel.model})`;
  } else {
    innerLlm = createLlm(config.llm);
    llmLabel = `${config.llm.provider}${config.llm.model ? ` / ${config.llm.model}` : ''}`;
  }
  // Wrap each provider in retry-on-transient logic. SwappableLlm sees the
  // wrapped client; settings.swap() goes through the same wrapper helper.
  const wrapWithRetry = (inner: ReturnType<typeof createLlmFromEntry>) =>
    new RetryingLlm(inner, undefined, (m) => app.log.warn(m));
  const llm = new SwappableLlm(wrapWithRetry(innerLlm), llmLabel);
  app.log.info(`LLM: ${llm.getLabel()} (with retry on 429/5xx/network)`);

  const ideationManager = new IdeationManager();

  const tts = new TtsService();
  tts.register(createFakeTtsProvider());

  // ── Register real TTS providers from .env ────────────────────
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    tts.register(createGeminiTtsProvider(geminiKey));
    app.log.info('TTS: Gemini provider registered');
  }

  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey) {
    tts.register(createXaiTtsProvider(xaiKey));
    app.log.info('TTS: xAI provider registered');
  }

  const wsRoot = resolve(import.meta.dirname, '../../..');

  // Fish Audio — local model via mlx_audio, no API key needed
  // Only register if both the model dir AND the Python module exist
  const fishModelPath = process.env.FISH_AUDIO_MODEL
    || `${process.env.HOME}/.lmstudio/models/mlx-community/fish-audio-s2-pro-bf16`;
  if (existsSync(fishModelPath)) {
    try {
      const { execFileSync } = await import('node:child_process');
      // Prefer .venv python (mlx-audio installed there)
      const venvPython = join(wsRoot, '.venv', 'bin', 'python3');
      const fishPython = existsSync(venvPython) ? venvPython : 'python3';
      execFileSync(fishPython, ['-c', 'import mlx_audio'], { timeout: 5000, stdio: 'pipe' });
      tts.register(createFishTtsProvider());
      app.log.info(`TTS: Fish Audio provider registered (model: ${fishModelPath}, python: ${fishPython})`);
    } catch {
      app.log.warn(`TTS: Fish Audio model found at ${fishModelPath} but mlx_audio Python module is not installed. Run: scripts/setup-python.sh`);
    }
  }

  await app.register(healthRoutes);
  await app.register(async (instance) => projectsRoutes(instance, { store, config }));
  await registerJobRoutes(app);
  await registerBrandRoutes(app, {
    paths: bPaths,
    registryFile: bPaths.registryFile,
    workspaceRoot: wsRoot,
    llm,
  });
  await app.register(async (instance) => registerStoryboardRoutes(instance, { store }));
  await app.register(async (instance) => registerIdeationRoutes(instance, { store, llm, ideationManager }));
  await app.register(async (instance) =>
    registerRecordingRoutes(instance, { store, llm, workspaceRoot: wsRoot, registry: modelRegistry }),
  );
  await app.register(async (instance) =>
    registerScriptRoutes(instance, { store, llm, workspaceRoot: wsRoot, registry: modelRegistry }),
  );
  await app.register(async (instance) =>
    registerNarrationRoutes(instance, { store, tts, llm, vpaHome: config.vpaHome }),
  );
  await app.register(async (instance) =>
    registerVoiceCloneRoutes(instance, { vpaHome: config.vpaHome, tts }),
  );
  await app.register(async (instance) =>
    registerSetupRoutes(instance, { tts, llm, vpaHome: config.vpaHome }),
  );
  await app.register(async (instance) =>
    registerRenderRoutes(instance, { store }),
  );
  await app.register(async (instance) =>
    registerSceneRenderRoutes(instance, {
      store,
      vpaHome: config.vpaHome,
      workspaceRoot: wsRoot,
    }),
  );
  await app.register(async (instance) =>
    registerMusicRoutes(instance, { store }),
  );
  await app.register(async (instance) =>
    registerSourceDocsRoutes(instance, { store }),
  );
  await app.register(async (instance) =>
    registerLowerThirdsRoutes(instance, { store, llm, workspaceRoot: wsRoot, registry: modelRegistry }),
  );
  await app.register(async (instance) =>
    registerQualityReviewRoutes(instance, { store, llm, workspaceRoot: wsRoot }),
  );
  await app.register(async (instance) =>
    registerOverlayRoutes(instance, { store, workspaceRoot: wsRoot, vpaHome: config.vpaHome }),
  );
  await app.register(async (instance) =>
    registerExportRoutes(instance, { store }),
  );
  await registerSettingsRoutes(app, { registry: modelRegistry, llm });

  return { app, config, store };
}

async function main() {
  const { app, config } = await buildServer();
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`vpa-server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void main();
}

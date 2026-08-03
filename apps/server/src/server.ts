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
import { registerShotPlanRoutes } from './routes/shot-plan.js';
import { ShotPlanManager } from './services/shot-plan/index.js';
import { registerRecordingRoutes } from './routes/recordings.js';
import { registerScriptRoutes } from './routes/scripts.js';
import { registerNarrationRoutes } from './routes/narration.js';
import { registerVoiceCloneRoutes } from './routes/voice-clone.js';
import { registerTtsScratchRoutes } from './routes/tts-scratch.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerRenderRoutes } from './routes/render.js';
import { registerSceneRenderRoutes } from './routes/scene-render.js';
import { registerMusicRoutes } from './routes/music.js';
import { registerSourceDocsRoutes } from './routes/source-docs.js';
import { registerLowerThirdsRoutes } from './routes/lower-thirds.js';
import { registerQualityReviewRoutes } from './routes/quality-review.js';
import { registerOverlayRoutes } from './routes/overlay.js';
import { registerExportRoutes } from './routes/export.js';
import { registerFramesRoutes } from './routes/frames.js';
import { registerSnapshotRoutes } from './routes/snapshots.js';
import { registerWorkflowStatusRoutes } from './routes/workflow-status.js';
import { registerAgentRecordingRoutes } from './routes/agent-recording.js';
import { ProjectStore } from './services/project/store.js';
import { trackerPath } from './services/project/paths.js';
import { resolve } from 'node:path';
import { brandPaths } from './services/brand/paths.js';
import { seedBrands } from './services/brand/seed.js';
import { createLlmFromEntry } from './services/llm/factory.js';
import { ModelRegistry } from './services/llm/model-registry.js';
import {
  ModelRouter,
  type CliReadinessProbe,
  type ModelRouterOptions,
} from './services/llm/model-router.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { IdeationManager } from './services/ideation/index.js';
import { TtsService, createFakeTtsProvider } from './services/tts/index.js';
import { createGeminiTtsProvider } from './services/tts/providers/gemini.js';
import { createXaiTtsProvider } from './services/tts/providers/xai.js';
import { createQwenTtsProvider } from './services/tts/providers/qwen.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { CapLocator } from './services/cap/locator.js';
import { ManagedCapRuntime, createCapProcess } from './services/cap/runtime.js';
import { CapInstaller } from './services/cap/installer.js';
import { createMacOSDesktopPlatform } from './services/desktop-driver/macos.js';
import { DesktopDriverSessionManager } from './services/desktop-driver/session.js';
import { registerAgentDesktopRoutes } from './routes/agent-desktop.js';
import { createCodexSceneRunner } from './services/agent-recording/codex-runner.js';
import {
  createAgentRecordingCoordinator,
  type AgentRecordingCoordinator,
} from './services/agent-recording/coordinator.js';
import { probeVideo } from './services/recording/metadata.js';
import { ingestRecording } from './services/recording/ingest.js';
import {
  VideoUnderstandingService,
  sanitizeVideoUnderstandingWarningFields,
  type VideoUnderstandingWarning,
} from './services/video-understanding/index.js';
import type { ServerConfig } from './config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const checkCliReady: CliReadinessProbe = async (provider) => {
  const executable = provider === 'claude-code' ? 'claude' : 'codex';
  try {
    await execFileAsync(executable, ['--version'], { timeout: 3_000 });
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

export interface BuildServerOptions {
  /** Test seam for hermetic server lifecycle and route wiring checks. */
  config?: ServerConfig;
  agentRecordingCoordinator?: AgentRecordingCoordinator;
  logger?: boolean;
  modelClientFactory?: ModelRouterOptions['createClient'];
  cliReadinessProbe?: CliReadinessProbe;
  videoUnderstanding?: VideoUnderstandingService;
  recordingProbe?: typeof probeVideo;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const config = options.config ?? loadConfig();
  const app = Fastify({ logger: options.logger ?? { level: 'info' } });

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
  const modelRouter = new ModelRouter({
    registry: modelRegistry,
    createClient: options.modelClientFactory ?? createLlmFromEntry,
    checkCliReady: options.cliReadinessProbe ?? checkCliReady,
    warn: (fields, message) => app.log.warn(fields, message),
  });

  const ideationManager = new IdeationManager();
  const shotPlanManager = new ShotPlanManager();

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
  const videoUnderstandingWarning: VideoUnderstandingWarning = (fields, message) => {
    const safeFields = sanitizeVideoUnderstandingWarningFields(fields);
    const safeMessage = message === 'Gemini video cleanup failed'
      ? 'Gemini video cleanup failed'
      : 'Video understanding failed';
    app.log.warn(safeFields, safeMessage);
  };
  const videoUnderstanding = options.videoUnderstanding ?? new VideoUnderstandingService({
    workspaceRoot: wsRoot,
    warn: videoUnderstandingWarning,
  });

  const capProcess = createCapProcess();
  const capLocator = new CapLocator({ vpaHome: config.vpaHome, run: capProcess.run });
  const capRuntime = new ManagedCapRuntime({ vpaHome: config.vpaHome, locator: capLocator, process: capProcess });
  const capInstaller = new CapInstaller({
    vpaHome: config.vpaHome,
    locator: capLocator,
    onState: (status) => capRuntime.setInstallationStatus(status),
  });
  const desktopDriver = new DesktopDriverSessionManager({
    platform: createMacOSDesktopPlatform(),
  });
  const codexRunner = createCodexSceneRunner(wsRoot);
  const agentRecordingCoordinator = options.agentRecordingCoordinator
    ?? createAgentRecordingCoordinator({
      cap: capRuntime,
      codex: codexRunner,
      desktop: desktopDriver,
      store,
      workspaceRoot: wsRoot,
      probeVideo,
      ingest: ingestRecording,
      driverBaseUrl: `http://127.0.0.1:${config.port}`,
    });

  // Qwen3-TTS — local voice cloning via mlx_audio. No API key needed.
  // Auto-downloads the model on first use; gated on the mlx_audio Python
  // module being importable.
  const { execFileSync } = await import('node:child_process');
  const venvPython = join(wsRoot, '.venv', 'bin', 'python3');
  const localPython = existsSync(venvPython) ? venvPython : 'python3';
  try {
    execFileSync(localPython, ['-c', 'import mlx_audio'], { timeout: 5000, stdio: 'pipe' });
    tts.register(createQwenTtsProvider());
    app.log.info(`TTS: Qwen3-TTS provider registered (python: ${localPython})`);
  } catch {
    app.log.warn('TTS: mlx_audio Python module not importable; local TTS disabled. Run: scripts/setup-python.sh');
  }

  await app.register(healthRoutes);
  await app.register(async (instance) => projectsRoutes(instance, {
    store,
    config,
    registry: modelRegistry,
    router: modelRouter,
  }));
  await registerJobRoutes(app);
  await registerBrandRoutes(app, {
    paths: bPaths,
    registryFile: bPaths.registryFile,
    workspaceRoot: wsRoot,
    // Needed so GET /api/brands/:slug/projects can list projects referencing
    // a brand (powers the Brand Usage tab + brand-delete safety check).
    trackerPath: trackerPath(config.vpaHome),
    router: modelRouter,
  });
  await app.register(async (instance) => registerStoryboardRoutes(instance, { store }));
  await app.register(async (instance) =>
    registerIdeationRoutes(instance, { store, router: modelRouter, ideationManager }),
  );
  await app.register(async (instance) =>
    registerShotPlanRoutes(instance, { store, router: modelRouter, shotPlanManager }),
  );
  await app.register(async (instance) =>
    registerRecordingRoutes(instance, {
      store,
      workspaceRoot: wsRoot,
      router: modelRouter,
      videoUnderstanding,
      probe: options.recordingProbe,
      agentRecordingCoordinator,
    }),
  );
  await app.register(async (instance) =>
    registerScriptRoutes(instance, {
      store,
      workspaceRoot: wsRoot,
      router: modelRouter,
      videoUnderstanding,
    }),
  );
  await app.register(async (instance) =>
    registerNarrationRoutes(instance, {
      store,
      tts,
      router: modelRouter,
      workspaceRoot: wsRoot,
      vpaHome: config.vpaHome,
    }),
  );
  await app.register(async (instance) =>
    registerVoiceCloneRoutes(instance, { vpaHome: config.vpaHome, tts }),
  );
  await app.register(async (instance) =>
    registerTtsScratchRoutes(instance, { vpaHome: config.vpaHome, tts }),
  );
  await app.register(async (instance) =>
    registerSetupRoutes(instance, {
      tts,
      router: modelRouter,
      vpaHome: config.vpaHome,
      capRuntime,
      capInstaller,
    }),
  );
  await app.register(async (instance) =>
    registerRenderRoutes(instance, {
      store,
      vpaHome: config.vpaHome,
      workspaceRoot: wsRoot,
      // Lets the render route resolve a project's brand → bumper / default
      // music track paths before kicking off ffmpeg.
      registryFile: bPaths.registryFile,
    }),
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
    registerLowerThirdsRoutes(instance, {
      store,
      workspaceRoot: wsRoot,
      router: modelRouter,
      videoUnderstanding,
      agentRecordingCoordinator,
    }),
  );
  await app.register(async (instance) =>
    registerQualityReviewRoutes(instance, { store, router: modelRouter, workspaceRoot: wsRoot }),
  );
  await app.register(async (instance) =>
    registerOverlayRoutes(instance, { store, workspaceRoot: wsRoot, vpaHome: config.vpaHome }),
  );
  await app.register(async (instance) =>
    registerExportRoutes(instance, { store }),
  );
  await app.register(async (instance) => registerFramesRoutes(instance, {}));
  await app.register(async (instance) => registerSnapshotRoutes(instance, { store }));
  await app.register(async (instance) => registerWorkflowStatusRoutes(instance, { store }));
  await app.register(async (instance) =>
    registerAgentRecordingRoutes(instance, { store, coordinator: agentRecordingCoordinator }),
  );
  await app.register(async (instance) => registerAgentDesktopRoutes(instance, { desktop: desktopDriver }));
  await registerSettingsRoutes(app, {
    registry: modelRegistry,
    router: modelRouter,
    store,
  });

  try {
    await agentRecordingCoordinator.reconcile();
  } catch (error) {
    app.log.error({ err: error }, 'Agent recording reconciliation failed; continuing startup');
  }

  return {
    app,
    config,
    store,
    capRuntime,
    capInstaller,
    desktopDriver,
    codexRunner,
    agentRecordingCoordinator,
  };
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

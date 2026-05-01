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
import { registerLowerThirdsRoutes } from './routes/lower-thirds.js';
import { registerQualityReviewRoutes } from './routes/quality-review.js';
import { registerOverlayRoutes } from './routes/overlay.js';
import { registerExportRoutes } from './routes/export.js';
import { ProjectStore } from './services/project/store.js';
import { resolve } from 'node:path';
import { brandPaths } from './services/brand/paths.js';
import { createLlm } from './services/llm/factory.js';
import { IdeationManager } from './services/ideation/index.js';
import { TtsService, createFakeTtsProvider } from './services/tts/index.js';

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

  const llm = createLlm(config.llm);
  app.log.info(`LLM provider: ${config.llm.provider}${config.llm.model ? ` (model: ${config.llm.model})` : ''}`);

  const ideationManager = new IdeationManager();

  const tts = new TtsService();
  tts.register(createFakeTtsProvider());

  const wsRoot = resolve(import.meta.dirname, '../../..');

  await app.register(healthRoutes);
  await app.register(async (instance) => projectsRoutes(instance, { store, config }));
  await registerJobRoutes(app);
  await registerBrandRoutes(app, {
    paths: bPaths,
    registryFile: bPaths.registryFile,
    workspaceRoot: config.vpaHome,
    llm,
  });
  await app.register(async (instance) => registerStoryboardRoutes(instance, { store }));
  await app.register(async (instance) => registerIdeationRoutes(instance, { store, llm, ideationManager }));
  await app.register(async (instance) =>
    registerRecordingRoutes(instance, { store, llm, workspaceRoot: wsRoot }),
  );
  await app.register(async (instance) =>
    registerScriptRoutes(instance, { store, llm, workspaceRoot: wsRoot }),
  );
  await app.register(async (instance) =>
    registerNarrationRoutes(instance, { store, tts, vpaHome: config.vpaHome }),
  );
  await app.register(async (instance) =>
    registerLowerThirdsRoutes(instance, { store, llm, workspaceRoot: wsRoot }),
  );
  await app.register(async (instance) =>
    registerQualityReviewRoutes(instance, { store, llm, workspaceRoot: wsRoot }),
  );
  await app.register(async (instance) =>
    registerOverlayRoutes(instance, { store, workspaceRoot: wsRoot }),
  );
  await app.register(async (instance) =>
    registerExportRoutes(instance, { store }),
  );

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

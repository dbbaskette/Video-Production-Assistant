import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { loadConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { projectsRoutes } from './routes/projects.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerBrandRoutes } from './routes/brands.js';
import { ProjectStore } from './services/project/store.js';
import { brandPaths } from './services/brand/paths.js';

export async function buildServer() {
  const config = loadConfig();
  const app = Fastify({ logger: { level: 'info' } });

  await app.register(cors, {
    origin: [config.webOrigin],
    credentials: false,
  });

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB per file
      files: 10,
    },
  });

  const store = new ProjectStore({
    vpaHome: config.vpaHome,
    projectsDefault: config.projectsDefault,
  });

  const bPaths = brandPaths(config.vpaHome, config.vpaHome);

  await app.register(healthRoutes);
  await app.register(async (instance) => projectsRoutes(instance, { store, config }));
  await registerJobRoutes(app);
  await registerBrandRoutes(app, {
    paths: bPaths,
    registryFile: bPaths.registryFile,
    workspaceRoot: config.vpaHome,
  });

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

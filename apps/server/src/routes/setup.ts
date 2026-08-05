import type { FastifyInstance } from 'fastify';
import { clearSetupHealthCache, runSetupHealth } from '../services/setup/probes.js';
import type { TtsService } from '../services/tts/index.js';
import type { ModelRouter } from '../services/llm/model-router.js';
import { CapSetupStatusSchema } from '@vpa/shared';
import { z } from 'zod';
import type { CapRuntime } from '../services/cap/runtime.js';
import type { CapInstaller } from '../services/cap/installer.js';

interface Deps {
  tts: TtsService;
  router: ModelRouter;
  vpaHome: string;
  capRuntime: Pick<CapRuntime, 'getStatus'>;
  capInstaller: Pick<CapInstaller, 'start'>;
}

export async function registerSetupRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  // GET /api/setup/health — run all probes (cached for 30 s) and return results.
  // Pass ?refresh=1 to bust the cache.
  app.get('/api/setup/health', async (req) => {
    const { refresh } = req.query as { refresh?: string };
    if (refresh) clearSetupHealthCache();
    return runSetupHealth(deps, { force: !!refresh });
  });

  app.get('/api/setup/cap', async () => {
    return CapSetupStatusSchema.parse(await deps.capRuntime.getStatus(false));
  });

  app.post('/api/setup/cap/check', async () => {
    return CapSetupStatusSchema.parse(await deps.capRuntime.getStatus(true));
  });

  app.post('/api/setup/cap/install', async (req, reply) => {
    const parsed = z.object({ confirmed: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Cap installation requires confirmed: true' });
    try {
      const job = await deps.capInstaller.start(parsed.data);
      return reply.code(202).send(job);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'INSTALL_IN_PROGRESS') {
        return reply.code(409).send({ error: error instanceof Error ? error.message : 'Cap installation is already in progress' });
      }
      req.log.error(error);
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Could not start Cap installation' });
    }
  });
}

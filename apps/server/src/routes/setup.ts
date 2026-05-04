import type { FastifyInstance } from 'fastify';
import { clearSetupHealthCache, runSetupHealth } from '../services/setup/probes.js';
import type { TtsService } from '../services/tts/index.js';
import type { LlmClient } from '../services/llm/index.js';

interface Deps {
  tts: TtsService;
  llm: LlmClient;
  vpaHome: string;
}

export async function registerSetupRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  // GET /api/setup/health — run all probes (cached for 30 s) and return results.
  // Pass ?refresh=1 to bust the cache.
  app.get('/api/setup/health', async (req) => {
    const { refresh } = req.query as { refresh?: string };
    if (refresh) clearSetupHealthCache();
    return runSetupHealth(deps, { force: !!refresh });
  });
}

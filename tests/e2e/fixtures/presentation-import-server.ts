import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import type { PresentationNarrationDrafter } from '../../../apps/server/src/services/presentation/narration-drafter.js';
import { createFakeProbe } from '../../../apps/server/src/services/recording/metadata.js';
import { buildServer } from '../../../apps/server/src/server.js';

const root = requiredPath('VPA_PRESENTATION_E2E_ROOT');
const vpaHome = requiredPath('VPA_PRESENTATION_E2E_HOME');
const projectsDefault = requiredPath('VPA_PRESENTATION_E2E_PROJECTS');
const port = requiredPort('VPA_PRESENTATION_E2E_API_PORT');
const webPort = requiredPort('VPA_PRESENTATION_E2E_WEB_PORT');
await validateOwnedDirectory(root, root);
await validateOwnedDirectory(vpaHome, root);
await validateOwnedDirectory(projectsDefault, root);

const providerCalls: string[] = [];
const bombDrafter = {
  async run() {
    providerCalls.push('drafter.run');
    throw new Error('Unexpected presentation drafter call in deterministic E2E');
  },
  async retry() {
    providerCalls.push('drafter.retry');
    throw new Error('Unexpected presentation drafter retry in deterministic E2E');
  },
} as PresentationNarrationDrafter;

const { app, config } = await buildServer({
  config: {
    port,
    host: '127.0.0.1',
    vpaHome,
    projectsDefault,
    webOrigin: `http://127.0.0.1:${webPort}`,
    llm: { provider: 'fake' },
    presentation: {
      maxBytes: 100 * 1024 * 1024,
      maxPages: 200,
    },
  },
  logger: false,
  presentationNarrationDrafter: bombDrafter,
  modelClientFactory: () => ({
    async complete() {
      providerCalls.push('writer.complete');
      throw new Error('Unexpected writer call in deterministic presentation E2E');
    },
  }),
  cliReadinessProbe: async () => ({ ready: false, message: 'Disabled in presentation E2E' }),
  recordingProbe: createFakeProbe(),
});

app.get('/api/__e2e/presentation-provider-calls', async () => ({ calls: providerCalls }));
await app.listen({ port: config.port, host: config.host });

function requiredPath(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function requiredPort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Missing valid ${name}`);
  }
  return value;
}

async function validateOwnedDirectory(path: string, expectedRoot: string): Promise<void> {
  const [info, canonicalPath, canonicalRoot] = await Promise.all([
    lstat(path),
    realpath(path),
    realpath(expectedRoot),
  ]);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || canonicalPath !== path
    || (path !== expectedRoot && dirname(path) !== canonicalRoot)
  ) {
    throw new Error('Presentation E2E storage must remain in its owned canonical root.');
  }
}

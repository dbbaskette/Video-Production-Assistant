import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

const apiPort = requiredPort('VPA_PRESENTATION_E2E_API_PORT');
const webPort = requiredPort('VPA_PRESENTATION_E2E_WEB_PORT');
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node --import tsx fixtures/presentation-import-server.ts',
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ANTHROPIC_API_KEY: '',
        GEMINI_API_KEY: '',
        OPENAI_API_KEY: '',
        XAI_API_KEY: '',
      },
    },
    {
      command: '../../node_modules/.bin/vite --config fixtures/presentation-import-vite.config.ts',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        VITE_VPA_API_BASE: '',
      },
    },
  ],
});

function requiredPort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Missing valid ${name}`);
  }
  return value;
}

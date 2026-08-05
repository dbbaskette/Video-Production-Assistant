import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node --import tsx fixtures/model-routing-server.ts',
      url: 'http://127.0.0.1:3100/api/health',
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
      command: 'npm run dev -w @vpa/web -- --host 127.0.0.1 --port 5174',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        VITE_VPA_API_BASE: 'http://127.0.0.1:3100',
      },
    },
  ],
});

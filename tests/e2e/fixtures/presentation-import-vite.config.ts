import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import process from 'node:process';

const apiPort = requiredPort('VPA_PRESENTATION_E2E_API_PORT');
const webPort = requiredPort('VPA_PRESENTATION_E2E_WEB_PORT');

export default defineConfig({
  root: resolve(import.meta.dirname, '../../../apps/web'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
});

function requiredPort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Missing valid ${name}`);
  }
  return value;
}

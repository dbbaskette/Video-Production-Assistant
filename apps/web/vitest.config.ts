import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // pure-logic utils only; switch to 'jsdom' when component tests are added (Task 8)
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});

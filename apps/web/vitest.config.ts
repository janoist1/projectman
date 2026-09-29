import { defineConfig } from 'vitest/config';

/**
 * Test config, separate from vite.config.ts: vitest 3 runs on vite 7, while the app build
 * uses vite 8 with @vitejs/plugin-react 6 (vite 8 only). esbuild handles JSX here.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});

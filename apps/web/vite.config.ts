import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverUrl = process.env.PROJECTMAN_SERVER_URL ?? 'http://127.0.0.1:4700';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': serverUrl,
      '/ws': { target: serverUrl.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});

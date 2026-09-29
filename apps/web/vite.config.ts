import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverUrl = process.env.PROJECTMAN_SERVER_URL ?? 'http://127.0.0.1:4700';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Keep the browser's Host header: the server accepts cookie-authenticated mutations only when
      // Origin and Host match (docs/SECURITY.md), and a rewritten Host would fail that check.
      '/api': { target: serverUrl, changeOrigin: false },
      '/ws': { target: serverUrl.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
  },
});

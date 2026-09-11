import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // maplibre-gl loads its worker from a separate module URL. Vite's
    // pre-bundling rewrites that URL to a file it never emits, so the worker
    // 404s and the base map silently stays blank. Serving maplibre unbundled
    // lets Vite resolve the worker the normal way.
    exclude: ['maplibre-gl'],
  },
  server: {
    port: 5173,
    proxy: {
      // Forwards to uvicorn in dev. Nothing uses it yet — the UI runs against
      // the mock adapter in src/api/mock — but it is here so the switch to the
      // real backend needs no config change.
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // FastAPI serves this directory once the backend exists.
    outDir: 'dist',
  },
});

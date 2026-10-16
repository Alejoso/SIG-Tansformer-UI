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
      // Forwards to uvicorn. Keep this in step with backend/run.sh: both
      // default to 8765 and both read MAPHEX_PORT, so moving the backend is
      // one variable rather than two edits.
      '/api': {
        target: `http://127.0.0.1:${process.env.MAPHEX_PORT ?? '8765'}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    // FastAPI serves this directory once the backend exists.
    outDir: 'dist',
  },
});

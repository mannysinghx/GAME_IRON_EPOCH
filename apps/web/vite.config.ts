import { defineConfig } from 'vite';

// All runtime assets (fonts, scripts, workers) are bundled and served from this host.
// No CDN, analytics, or remote model lookups (design doc §10.2).
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: '127.0.0.1' },
});

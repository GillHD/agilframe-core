import { defineConfig } from 'vite';

/**
 * Visual editor for the AgilFrame panel.
 *
 * Served from `/editor/` by the calls server in production, dev on port 5174.
 * `/v1` is proxied to the local server so "Save to tenant" works in dev without
 * CORS configuration.
 */
export default defineConfig({
  base: '/editor/',
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/v1': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});

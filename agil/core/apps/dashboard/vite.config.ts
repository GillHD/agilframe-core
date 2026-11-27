import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Developer dashboard.
 *
 * The panel imports `@agil/protocol` from source so it can be built before the
 * protocol package is compiled; the alias mirrors `tsconfig.json` paths.
 */
const protocolEntry = fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url));

export default defineConfig({
  base: '/dashboard/',
  publicDir: fileURLToPath(new URL('../editor/public/', import.meta.url)),
  resolve: {
    alias: {
      '@agil/protocol': protocolEntry,
    },
  },
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/v1': { target: 'http://localhost:8787', changeOrigin: false },
      '/sdk': { target: 'http://localhost:8787', changeOrigin: false },
    },
  },
  preview: {
    port: 5175,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});

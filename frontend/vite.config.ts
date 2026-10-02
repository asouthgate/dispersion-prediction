import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { fileURLToPath } from 'node:url';

const nodeShim = fileURLToPath(new URL('./src/shims/node-empty.ts', import.meta.url));

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  worker: {
    plugins: () => [wasm(), topLevelAwait()],
    format: 'es',
  },
  resolve: {
    alias: {
      '@': '/src',
      // @ngageoint/geopackage's browser bundle references Node built-ins only
      // in Node-gated code paths; stub them so esbuild can bundle it.
      fs: nodeShim,
      path: nodeShim,
      crypto: nodeShim,
    },
  },
  server: {
    port: 5184,
    proxy: {
      '/api': process.env.VITE_PROXY_API || 'http://localhost:8084',
    },
  },
});

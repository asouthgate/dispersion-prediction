import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { fileURLToPath } from 'node:url';

const nodeShim = fileURLToPath(new URL('./src/shims/node-empty.ts', import.meta.url));

export default defineConfig({
  plugins: [react(), wasm()],
  build: { target: 'esnext' },
  worker: {
    plugins: () => [wasm()],
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
    dedupe: ['react', 'react-dom']
  },
  server: {
    port: 5184,
    proxy: {
      '/api': process.env.VITE_PROXY_API || 'http://localhost:8084',
    },
  },
});

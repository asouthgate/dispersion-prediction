import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  worker: {
    plugins: () => [wasm(), topLevelAwait()],
    format: 'es',
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    port: 5184,
    proxy: {
      '/api': process.env.VITE_PROXY_API || 'http://localhost:8084',
    },
  },
});

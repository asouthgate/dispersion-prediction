import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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

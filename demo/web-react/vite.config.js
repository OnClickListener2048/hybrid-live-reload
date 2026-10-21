import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The bundle is served at the production origin root, so absolute
  // /assets/... URLs are exactly what the DevShell interceptor expects.
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

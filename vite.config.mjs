import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths so the production build loads under Electron's file://
  // protocol. With the default '/' base, dist/index.html references /assets/...,
  // which file:// resolves to the filesystem root — the renderer never loads and
  // the window shows only its background (a blank/black screen). Dev over http
  // masks this; only the packaged build hits it.
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});

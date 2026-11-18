import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/obs-folia/',
  plugins: [react()],
  build: {
    outDir: '../app/standalone/public/obs-folia',
    emptyOutDir: true,
    target: 'chrome110',
  },
});

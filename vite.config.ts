import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { runtimeAssets } from './build/runtime-assets.ts'
import { pwa } from './build/pwa-plugin.ts'

// https://vite.dev/config/
export default defineConfig({
  // relative asset paths: the app also works from a sub-folder (e.g. GitHub Pages)
  base: './',
  plugins: [react(), runtimeAssets(), pwa()],
  worker: { format: 'es' },
  build: {
    // MuPDF uses top-level await
    target: 'es2022',
    // pdf.js (~850 kB) and MuPDF are lazy-loaded per tool, so the warning is noise
    chunkSizeWarningLimit: 1400,
  },
})

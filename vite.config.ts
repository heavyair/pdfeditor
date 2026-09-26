import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // pdf.js alone is ~850 kB; it is lazy-loaded per tool, so the warning is noise
    chunkSizeWarningLimit: 1400,
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    open: true, // Browser automatisch öffnen
    port: 5173,  // Standard-Port von Vite
    proxy: {
      '/api/slang': {
        target: 'https://slang.slowsoft.ch',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/slang/, '/webslang'),
        secure: true,
      }
    }
  }
}) 
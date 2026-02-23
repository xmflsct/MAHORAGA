import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiTarget = process.env.MAHORAGA_API_URL || `http://localhost:${process.env.WRANGLER_PORT || '8787'}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    proxy: {
      '/agent': {
        target: apiTarget,
        changeOrigin: true,
        secure: true,
      },
    },
  },
})

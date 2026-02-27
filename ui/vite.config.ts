import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const GATEWAY_PORT = process.env.GATEWAY_PORT ?? "28789"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 10000,
    proxy: {
      '/ws': {
        target: `http://localhost:${GATEWAY_PORT}`,
        ws: true,
      },
    },
  },
})

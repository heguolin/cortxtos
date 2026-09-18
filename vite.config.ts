import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'src/web',
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000',
      '/files': 'http://127.0.0.1:3000',
    },
  },
})

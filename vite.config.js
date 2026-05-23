import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/anthropic/, ''),
        headers: {
          'x-api-key': 'YOUR_KEY_HERE',
          'anthropic-version': '2023-06-01',
        },
      },
    },
  },
})


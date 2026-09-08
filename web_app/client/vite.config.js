import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    // While running `npm run dev` locally, proxy API calls to the Express
    // server so you don't hit CORS issues during development.
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
});

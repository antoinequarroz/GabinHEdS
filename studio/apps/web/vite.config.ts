import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 4311),
    strictPort: true,
    proxy: {
      '/api': { target: process.env.VITE_API_PROXY ?? 'http://127.0.0.1:4310', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});

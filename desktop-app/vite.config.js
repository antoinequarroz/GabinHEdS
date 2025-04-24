import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: './', // <-- Chemin base vide pour Electron
  server: {
    port: 3001,
    strictPort: true,
  },
});

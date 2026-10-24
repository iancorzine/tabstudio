import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  server: { port: 5173, host: 'localhost' },
  build: { target: 'es2022', rollupOptions: { input: { main: 'index.html', selftest: 'selftest.html' } } },
  worker: { format: 'es' },
});

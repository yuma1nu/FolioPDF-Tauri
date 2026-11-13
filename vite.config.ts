import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()], base: './', clearScreen: false,
  optimizeDeps: { include: ['pdf-lib'] },
  server: { host: '127.0.0.1', port: 1427, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/test-results/**'] } },
  build: { outDir: 'dist', target: 'es2023', rolldownOptions: { input: ['index.html', 'print.html'] } },
  worker: { format: 'es' }
});


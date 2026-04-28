import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'css-validate',
      buildStart() {
        try {
          execSync('node scripts/validate-css.js', { stdio: 'inherit' });
        } catch (e) {
          throw new Error('CSS validation failed. Fix errors before building.');
        }
      },
    },
  ],
  server: {
    allowedHosts: ['dashboard.chuonglv.site'],
    proxy: {
      '/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/admin': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: '../public/admin-next',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/main.tsx'),
      output: {
        manualChunks: {
          xterm: ['@xterm/xterm', '@xterm/addon-fit'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  }
});

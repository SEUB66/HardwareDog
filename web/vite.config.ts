/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Relative base so the same build can be served from the device flash,
// a local file server, or any sub-path without rewriting URLs.
export default defineConfig({
  base: './',
  plugins: [preact()],
  // Brand derivatives live in ../assets/brand/web, next to their sources.
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 0,
    reportCompressedSize: true,
    rollupOptions: { input: { home: 'index.html', diagnostic: 'diagnostic.html' } },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});

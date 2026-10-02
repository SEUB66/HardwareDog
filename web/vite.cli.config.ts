import { defineConfig } from 'vite';

// The hwdog command line (src/cli/hwdog.ts): the interface's core, bundled
// for Node. npm run cli -> dist-cli/hwdog.mjs
export default defineConfig({
  build: {
    ssr: 'src/cli/hwdog.ts',
    outDir: 'dist-cli',
    target: 'node20',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'hwdog.mjs' } },
  },
});

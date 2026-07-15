import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // The introspection worker ships as a sibling entry; main resolves
          // it via import.meta.dirname at runtime (utilityProcess.fork).
          inspectWorker: resolve(import.meta.dirname, 'src/worker/inspectWorker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: {
          // CJS so the preload runs in a sandboxed renderer (ESM preload
          // would force sandbox: false).
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [svelte()],
  },
});

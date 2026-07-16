import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

// The dev CSP in index.html allows Vite HMR on localhost; production must
// not (a compromised renderer could otherwise reach arbitrary local ports).
// This transform swaps in the strict CSP at build time.
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'";

function productionCsp(): Plugin {
  return {
    name: 'kozou-desktop:production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const replaced = html.replace(
        /<meta http-equiv="Content-Security-Policy" content="[^"]*" \/>/,
        `<meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />`,
      );
      if (replaced === html) {
        throw new Error('production-csp: CSP meta tag not found in index.html');
      }
      return replaced;
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // Workers ship as sibling entries; main resolves them via
          // import.meta.dirname at runtime (utilityProcess.fork).
          inspectWorker: resolve(import.meta.dirname, 'src/worker/inspectWorker.ts'),
          mcpServerWorker: resolve(import.meta.dirname, 'src/worker/mcpServerWorker.ts'),
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
    plugins: [svelte(), productionCsp()],
  },
});

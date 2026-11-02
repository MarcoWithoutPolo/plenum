import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
// Bundle the engine straight from source, so the app has no workspace links to package.
const alias = {
  '@conclave/core': resolve(root, 'packages/core/src/index.ts'),
  '@conclave/shared': resolve(root, 'packages/shared/src/index.ts'),
};

/** Strict CSP for the packaged renderer. Dev skips it because Vite's hot reload injects inline scripts. */
const csp = {
  name: 'conclave-csp',
  transformIndexHtml: {
    order: 'post' as const,
    handler(html: string, ctx: { server?: unknown }) {
      if (ctx.server) return html;
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        // The live preview: only pages served on this computer (Conclave's server or a dev server).
        'frame-src http://127.0.0.1:* http://localhost:*',
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  },
};

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(here, 'src/main/index.ts'),
          // `Conclave --mcp`, run as plain Node (F9).
          mcp: resolve(here, 'src/main/mcp.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve(here, 'src/preload/index.ts'),
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(here, 'src/renderer'),
    resolve: { alias: { ...alias, '@': resolve(here, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), csp],
    build: {
      outDir: resolve(here, 'out/renderer'),
      rollupOptions: { input: resolve(here, 'src/renderer/index.html') },
    },
  },
});

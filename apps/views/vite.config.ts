import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { defineConfig } from 'vitest/config';

const contracts = resolve(import.meta.dirname, '../../libs/contracts/src/index.ts');

/**
 * The MCP App builds to one self-contained file, dist/view.html (scripts, styles and the Geist fonts inlined): MCP
 * Apps hosts load a `ui://` resource as a single HTML document in a sandbox with no network, and the API serves this
 * file as `ui://clickland/view`.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true })],
  resolve: { alias: { '@clickland/contracts': contracts } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: resolve(import.meta.dirname, 'view.html') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
    alias: { '@clickland/contracts': contracts },
  },
});

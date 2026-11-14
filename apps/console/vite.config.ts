import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const workspace = resolve(import.meta.dirname, '../..');
const contracts = resolve(workspace, 'libs/contracts/src/index.ts');

export default defineConfig(({ mode }) => {
  // Ports come from the workspace .env like every other process (CLICKLAND_* only; nothing reaches the bundle).
  const env = { ...loadEnv(mode, workspace, 'CLICKLAND_'), ...process.env };
  const port = Number(env.CLICKLAND_CONSOLE_PORT ?? 4711);
  const api = `http://127.0.0.1:${Number(env.CLICKLAND_API_PORT ?? 4710)}`;
  const server = {
    host: '127.0.0.1',
    port,
    strictPort: true,
    // Pods in the clickland-dev namespace reach this dev server through an ExternalName to host.orb.internal.
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      'clickland-console.clickland-dev',
      'clickland-console.clickland-dev.svc.cluster.local',
      'host.orb.internal',
    ],
    // The assistant's answer streams (server-sent events); the proxy passes it through as it comes.
    proxy: { '/api': { target: api, changeOrigin: false }, '/scim': api },
  };
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': resolve(import.meta.dirname, 'src'), '@clickland/contracts': contracts } },
    server,
    preview: server,
    build: { chunkSizeWarningLimit: 1500 },
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.{ts,tsx}'],
      css: false,
    },
  };
});

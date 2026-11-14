import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
    alias: { '@clickland/contracts': resolve(import.meta.dirname, '../contracts/src/index.ts') },
  },
});

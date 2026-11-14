import { defineConfig } from 'vitest/config';

// No schema integration tests yet (the migrations run in every other package's); pass so `pnpm test:integration` runs.
export default defineConfig({
  test: { include: ['test/**/*.integration.test.ts'], testTimeout: 60_000, passWithNoTests: true },
});

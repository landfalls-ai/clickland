import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// uPlot reads matchMedia when it loads; jsdom has none (these tests draw no charts).
vi.stubGlobal(
  'matchMedia',
  (query: string) =>
    ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList,
);

afterEach(() => cleanup());

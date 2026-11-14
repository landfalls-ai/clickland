import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom has no canvas: charts are tested for what they put in the DOM (legend, empty state), not the pixels.
vi.mock('uplot', () => {
  class FakePlot {
    static paths = { bars: () => () => null };
    cursor = { idx: null };
    over = document.createElement('div');
    select = { left: 0, width: 0, top: 0, height: 0 };
    constructor(_opts: unknown, _data: unknown, target: HTMLElement) {
      const canvas = document.createElement('div');
      canvas.className = 'fake-uplot';
      target.appendChild(canvas);
    }
    destroy() {}
    setSelect() {}
    posToVal() {
      return 0;
    }
  }
  return { default: FakePlot };
});

class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    void target;
  }
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver);

afterEach(() => cleanup());

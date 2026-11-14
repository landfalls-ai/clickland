import { useEffect, useRef, useState } from 'react';

/** Bumps when the theme changes (data-theme, inline host styles, or the OS scheme), so charts redraw their colours. */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(bump) : undefined;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style', 'class'],
    });
    const media =
      typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
    media?.addEventListener?.('change', bump);
    return () => {
      observer?.disconnect();
      media?.removeEventListener?.('change', bump);
    };
  }, []);
  return version;
}

/** The width of an element, tracked with ResizeObserver. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? el.clientWidth);
      setWidth((prev) => (prev === w ? prev : w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

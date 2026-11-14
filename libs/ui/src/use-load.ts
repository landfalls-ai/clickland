import { useEffect, useState } from 'react';

export interface Loaded<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

/**
 * Loads `fn` whenever `key` changes, keeping the previous data while it reloads (a refresh doesn't flash) and
 * ignoring answers that arrive after a newer request started.
 */
export function useLoad<T>(key: string, fn: () => Promise<T>, enabled = true): Loaded<T> {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: Error; done: boolean }>({
    key: null,
    done: false,
  });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fn().then(
      (data) => live && setState({ key, data, done: true }),
      (error: unknown) =>
        live &&
        setState((prev) => ({
          key,
          data: prev.data,
          error: error instanceof Error ? error : new Error(String(error)),
          done: true,
        })),
    );
    return () => {
      live = false;
    };
    // `fn` is a fresh closure each render; `key` names what it loads.
  }, [key, enabled]);
  const current = state.key === key;
  return {
    data: state.data,
    error: current ? state.error : undefined,
    loading: enabled && (!current || !state.done),
  };
}

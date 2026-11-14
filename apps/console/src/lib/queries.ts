import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Alert, AlertEvent, AlertInput, Note, Signal, View, ViewSpec } from '@clickland/contracts';
import { get, qs, quiet, send } from './api';
import type { ApiKey, CreatedView, FacetField, MetricName, ViewSummary, Webhook } from './types';

type Bounds = { from: string; to: string };

export const useFacets = (signal: Signal, bounds: Bounds) =>
  useQuery({
    queryKey: ['facets', signal, bounds.from, bounds.to],
    queryFn: () => send<{ fields: FacetField[] }>('POST', '/api/facets', { signal, ...bounds }),
    retry: quiet,
    placeholderData: (prev) => prev,
  });

export const useMetricNames = (bounds: Bounds) =>
  useQuery({
    queryKey: ['metric-names', bounds.from.slice(0, 15), bounds.to.slice(0, 15)],
    queryFn: () => get<{ metrics: MetricName[] }>(`/api/metrics/names${qs(bounds)}`),
    retry: quiet,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

export const useAlerts = () =>
  useQuery({
    queryKey: ['alerts'],
    queryFn: () => get<{ alerts: Alert[] }>('/api/alerts'),
    retry: quiet,
    refetchInterval: 15_000,
  });

export const useAlert = (id: string | undefined) =>
  useQuery({
    queryKey: ['alerts', id],
    queryFn: () => get<Alert>(`/api/alerts/${id}`),
    enabled: Boolean(id),
    retry: quiet,
    refetchInterval: 15_000,
  });

export const useAlertEvents = (id: string | undefined) =>
  useQuery({
    queryKey: ['alerts', id, 'events'],
    queryFn: () => get<{ events: AlertEvent[] }>(`/api/alerts/${id}/events?limit=50`),
    enabled: Boolean(id),
    retry: quiet,
    refetchInterval: 15_000,
  });

export const useViews = (pinned?: boolean) =>
  useQuery({
    queryKey: ['views', pinned ?? 'all'],
    queryFn: () => get<{ views: ViewSummary[] }>(`/api/views${qs({ pinned })}`),
    retry: quiet,
  });

export const useView = (id: string | undefined) =>
  useQuery({
    queryKey: ['views', 'one', id],
    queryFn: () => get<View>(`/api/views/${id}`),
    enabled: Boolean(id),
    retry: quiet,
  });

export const useNotes = (q: string) =>
  useQuery({
    queryKey: ['notes', q],
    queryFn: () => get<{ notes: Note[] }>(`/api/notes${qs({ q, limit: 100 })}`),
    retry: quiet,
    placeholderData: (prev) => prev,
  });

export const useKeys = (enabled: boolean) =>
  useQuery({
    queryKey: ['keys'],
    queryFn: async () => {
      const body = await get<{ keys: ApiKey[] } | ApiKey[]>('/api/keys');
      return Array.isArray(body) ? body : body.keys;
    },
    enabled,
    retry: quiet,
  });

export const useWebhooks = (enabled: boolean) =>
  useQuery({
    queryKey: ['webhooks'],
    queryFn: () => get<{ webhooks: Webhook[] }>('/api/webhooks'),
    enabled,
    retry: quiet,
  });

/** A write that refreshes the lists it touches. */
export function useWrite<A, R>(fn: (args: A) => Promise<R>, touches: string[]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of touches) void client.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const api = {
  createAlert: (input: AlertInput) => send<Alert>('POST', '/api/alerts', input),
  updateAlert: ({ id, input }: { id: string; input: AlertInput }) => send<Alert>('PUT', `/api/alerts/${id}`, input),
  deleteAlert: (id: string) => send<void>('DELETE', `/api/alerts/${id}`),
  testAlert: (id: string) =>
    send<{ groups: { groupKey: string; value: number; wouldFire: boolean }[] }>('POST', `/api/alerts/${id}/test`),
  createView: (body: { spec: ViewSpec; pinned: boolean }) => send<CreatedView>('POST', '/api/views', body),
  updateView: ({ id, ...body }: { id: string; spec?: ViewSpec; title?: string; pinned?: boolean; version?: number }) =>
    send<View>('PUT', `/api/views/${id}`, body),
  deleteView: (id: string) => send<void>('DELETE', `/api/views/${id}`),
  createNote: (input: { title: string; body: string; service?: string | null; tags: string[]; traceIds: string[] }) =>
    send<Note>('POST', '/api/notes', input),
  createKey: (input: { name: string; scopes: string[] }) => send<ApiKey & { key: string }>('POST', '/api/keys', input),
  deleteKey: (id: string) => send<void>('DELETE', `/api/keys/${id}`),
  createWebhook: (input: { url: string; events: string[]; alertId: string | null; description: string }) =>
    send<Webhook & { secret: string }>('POST', '/api/webhooks', input),
  deleteWebhook: (id: string) => send<void>('DELETE', `/api/webhooks/${id}`),
};

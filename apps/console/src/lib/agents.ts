/** Data for the Agents pages (docs/agent-value.md#console-spec): the period, the queries and the writes. */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AgentAlertTemplate,
  AgentDetailResponse,
  AgentFamily,
  Alert,
  ModelPrice,
  ModelPriceInput,
  OutcomeDefinition,
  OutcomeInput,
  AgentsResponse,
  RunGraphResponse,
  SafetyResponse,
  ValueReportResponse,
  ValueSettings,
  ValueSettingsInput,
} from '@clickland/contracts';
import { get, qs, quiet, send } from './api';

export const PERIODS = [
  { value: '24h', label: '24 hours', days: 1 },
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
] as const;
export type Period = (typeof PERIODS)[number]['value'];

type Bounds = { from: string; to: string };

const minuteNow = () => Math.ceil(Date.now() / 60_000) * 60_000;

/** The period picker's value (`?period=`, default 7 days) and the bounds it gives, to the minute. */
export function useAgentPeriod() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('period');
  const period: Period = PERIODS.some((p) => p.value === raw) ? (raw as Period) : '7d';
  // The end of the period, to the minute: set when the page opens and when the period changes.
  const [to, setTo] = useState(minuteNow);
  const bounds = useMemo<Bounds>(() => {
    const days = PERIODS.find((p) => p.value === period)!.days;
    return { from: new Date(to - days * 86_400_000).toISOString(), to: new Date(to).toISOString() };
  }, [period, to]);
  const setPeriod = (next: Period) => {
    setTo(minuteNow());
    const p = new URLSearchParams(params);
    if (next === '7d') p.delete('period');
    else p.set('period', next);
    setParams(p);
  };
  /** `?period=` to carry to another Agents page. */
  const carry = period === '7d' ? '' : `?period=${period}`;
  return { period, setPeriod, bounds, carry, params, setParams };
}

const live = { retry: quiet, placeholderData: keepPreviousData, refetchInterval: 60_000 } as const;

export const useValueReport = (bounds: Bounds, filter: { team?: string | null; service?: string | null } = {}) =>
  useQuery({
    queryKey: ['agents', 'value', bounds.from, bounds.to, filter.team ?? '', filter.service ?? ''],
    queryFn: () => get<ValueReportResponse>(`/api/agents/value${qs({ ...bounds, ...filter })}`),
    ...live,
  });

export const useAgentList = (bounds: Bounds, family?: AgentFamily | null) =>
  useQuery({
    queryKey: ['agents', 'list', bounds.from, bounds.to, family ?? ''],
    queryFn: () => get<AgentsResponse>(`/api/agents${qs({ ...bounds, family })}`),
    ...live,
  });

export const useAgentDetail = (id: string | undefined, bounds: Bounds) =>
  useQuery({
    queryKey: ['agents', 'one', id, bounds.from, bounds.to],
    queryFn: () => get<AgentDetailResponse>(`/api/agents/${encodeURIComponent(id!)}${qs(bounds)}`),
    enabled: Boolean(id),
    ...live,
  });

export const useRunGraph = (traceId: string | undefined) =>
  useQuery({
    queryKey: ['agents', 'run', traceId],
    queryFn: () => get<RunGraphResponse>(`/api/agents/runs/${encodeURIComponent(traceId!)}/graph`),
    enabled: Boolean(traceId),
    retry: quiet,
  });

export const useSafety = (bounds: Bounds) =>
  useQuery({
    queryKey: ['agents', 'safety', bounds.from, bounds.to],
    queryFn: () => get<SafetyResponse>(`/api/agents/safety${qs(bounds)}`),
    ...live,
  });

export const useValueSettings = () =>
  useQuery({ queryKey: ['value', 'settings'], queryFn: () => get<ValueSettings>('/api/value/settings'), retry: quiet });

export const usePrices = () =>
  useQuery({
    queryKey: ['value', 'prices'],
    queryFn: async () => (await get<{ prices: ModelPrice[] }>('/api/value/prices')).prices,
    retry: quiet,
  });

export const useOutcomes = () =>
  useQuery({
    queryKey: ['value', 'outcomes'],
    queryFn: async () => (await get<{ outcomes: OutcomeDefinition[] }>('/api/value/outcomes')).outcomes,
    retry: quiet,
  });

export const useAlertTemplates = (enabled = true) =>
  useQuery({
    queryKey: ['agents', 'alert-templates'],
    queryFn: async () => (await get<{ templates: AgentAlertTemplate[] }>('/api/agents/alert-templates')).templates,
    enabled,
    retry: quiet,
    staleTime: 300_000,
  });

export interface OutcomePreview {
  matched: number;
  credited: number;
  unattributed: number;
  unitValue: number;
  value: number;
  how?: string;
  unitHow?: string;
  [key: string]: unknown;
}

export interface SeedResult {
  prices: { added: number; refreshed: number; kept: number };
  outcomes: { added: number; refreshed: number; kept: number };
}

export const agentApi = {
  updateSettings: (input: ValueSettingsInput) => send<ValueSettings>('PUT', '/api/value/settings', input),
  createPrice: (input: ModelPriceInput) => send<ModelPrice>('POST', '/api/value/prices', input),
  updatePrice: ({ id, input }: { id: string; input: ModelPriceInput }) =>
    send<ModelPrice>('PUT', `/api/value/prices/${id}`, input),
  deletePrice: (id: string) => send<void>('DELETE', `/api/value/prices/${id}`),
  createOutcome: (input: OutcomeInput) => send<OutcomeDefinition>('POST', '/api/value/outcomes', input),
  updateOutcome: ({ id, input }: { id: string; input: OutcomeInput }) =>
    send<OutcomeDefinition>('PUT', `/api/value/outcomes/${id}`, input),
  deleteOutcome: (id: string) => send<void>('DELETE', `/api/value/outcomes/${id}`),
  previewOutcome: (body: { outcome: OutcomeInput } & Bounds) =>
    send<OutcomePreview>('POST', '/api/value/outcomes/preview', body),
  seed: () => send<SeedResult>('POST', '/api/value/seed'),
  installTemplate: (key: string) => send<Alert>('POST', `/api/agents/alert-templates/${key}/install`),
};

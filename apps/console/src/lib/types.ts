import type { ApiScope, Signal, View, WebhookEvent } from '@clickland/contracts';

/** Shapes the API returns that libs/contracts doesn't type yet (docs/reference/api.md describes them). */

export type Role = 'viewer' | 'editor' | 'admin';

export interface Me {
  user: { name: string; email: string; roles: string[] };
  authMode: string;
}

export interface FacetField {
  field: string;
  values: { value: string; count: number }[];
}

export interface MetricName {
  name: string;
  type: 'gauge' | 'sum' | 'histogram';
  unit: string;
  description: string;
  services: string[];
}

export interface ViewSummary {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
}

export interface CreatedView {
  id: string;
  url: string;
  resourceUri: string;
  marker: string;
}

export type { View };

export interface ApiKey {
  id: string;
  name: string;
  scopes: ApiScope[];
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string | null;
  prefix?: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  alertId: string | null;
  description: string;
  createdAt: string;
}

export interface SearchParamsState {
  signal: Signal;
  query: string;
  from: string;
  to: string;
}

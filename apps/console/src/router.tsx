import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from './components/shell/app-shell';
import { AlertPage } from './routes/alert';
import { AlertsPage } from './routes/alerts';
import { AssistantPage } from './routes/assistant';
import { ViewPage } from './routes/dashboard';
import { DashboardEditPage } from './routes/dashboard-edit';
import { DashboardsPage } from './routes/dashboards';
import { MetricsPage } from './routes/metrics';
import { NotesPage } from './routes/notes';
import { NotFoundPage } from './routes/not-found';
import { PatternsPage } from './routes/patterns';
import { SearchPage } from './routes/search';
import { ServicePage } from './routes/service';
import { ServicesPage } from './routes/services';
import { SettingsPage } from './routes/settings';
import { TracePage } from './routes/trace';

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/search" replace /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'traces/:id', element: <TracePage /> },
      { path: 'services', element: <ServicesPage /> },
      { path: 'services/:name', element: <ServicePage /> },
      { path: 'metrics', element: <MetricsPage /> },
      { path: 'patterns', element: <PatternsPage /> },
      { path: 'alerts', element: <AlertsPage /> },
      { path: 'alerts/new', element: <AlertPage /> },
      { path: 'alerts/:id', element: <AlertPage /> },
      { path: 'dashboards', element: <DashboardsPage /> },
      { path: 'dashboards/new', element: <DashboardEditPage /> },
      { path: 'dashboards/:id', element: <ViewPage kind="dashboard" /> },
      { path: 'dashboards/:id/edit', element: <DashboardEditPage /> },
      { path: 'views/:id', element: <ViewPage kind="view" /> },
      { path: 'assistant', element: <AssistantPage /> },
      { path: 'notes', element: <NotesPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { routes } from './router';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5000, refetchOnWindowFocus: false } } });
const router = createBrowserRouter(routes);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" toastOptions={{ className: 'font-sans' }} />
    </QueryClientProvider>
  </StrictMode>,
);

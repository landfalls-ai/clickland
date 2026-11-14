import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { ApiError } from './lib/api';
import { routes } from './router';
import './index.css';

// A 401 anywhere means the session ended (signed out, or deactivated in Landbright): ask "me" again, which shows the
// sign-in page.
const onError = (error: unknown) => {
  if (error instanceof ApiError && error.status === 401) void queryClient.invalidateQueries({ queryKey: ['me'] });
};
const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5000, refetchOnWindowFocus: false } },
  queryCache: new QueryCache({ onError: (error, query) => query.queryKey[0] !== 'me' && onError(error) }),
  mutationCache: new MutationCache({ onError }),
});
const router = createBrowserRouter(routes);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" toastOptions={{ className: 'font-sans' }} />
    </QueryClientProvider>
  </StrictMode>,
);

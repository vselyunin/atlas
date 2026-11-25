import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { AuthGate } from './features/auth/AuthGate';
import { initializeTheme } from './lib/theme';
import './styles.css';

initializeTheme();

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});
const element = document.getElementById('root');
if (!element) throw new Error('Missing root element');
createRoot(element).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <AuthGate>
        <App />
      </AuthGate>
    </QueryClientProvider>
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/global.css';

async function bootstrap(): Promise<void> {
  // Mock mode (VITE_MOCK=1): in-memory backend and websocket, no server needed.
  if (import.meta.env.VITE_MOCK === '1') {
    const { installMocks } = await import('./mocks');
    installMocks();
  }
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing #root element');
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();

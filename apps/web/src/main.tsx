import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { registerPwa } from './pwa/register';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
registerPwa();
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

/** Placeholder root; the web workstream replaces it with the real app shell. */
function App() {
  return <p>projectman</p>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

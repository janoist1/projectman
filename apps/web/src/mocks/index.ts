import { setFetchImplementation } from '../api/client';
import { setWebSocketFactory } from '../api/socket';
import { MockBackend } from './backend';
import type { MockAuthState } from './backend';
import { startSimulation } from './simulation';
import { MockWebSocket, createMockFetch } from './transport';

/**
 * Mock mode (VITE_MOCK=1): the REST client and the websocket talk to an in-memory backend
 * with the fictional "Acme webshop" fixtures and a few simulated live events. `?mock-auth=setup` starts at
 * the first-run setup, `?mock-auth=login` at the login page.
 */
export function installMocks(): MockBackend {
  const param = new URLSearchParams(window.location.search).get('mock-auth');
  const auth: MockAuthState = param === 'setup' || param === 'login' ? param : 'ready';
  const backend = new MockBackend(auth);
  backend.setSimulation(() => startSimulation(backend));
  setFetchImplementation(createMockFetch(backend));
  setWebSocketFactory(() => new MockWebSocket(backend));
  return backend;
}

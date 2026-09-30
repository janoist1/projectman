import type { ReactElement } from 'react';
import { setFetchImplementation } from '../api/client';
import { ProjectContext } from '../app/contexts';
import type { ProjectContextValue } from '../app/contexts';
import { MockBackend } from '../mocks/backend';
import { renderUi } from './render';

export interface MockRequest {
  method: string;
  path: string;
  body: unknown;
}

/** A fetch() that answers /api requests from the in-memory backend and records each request. */
export function createMockFetch(backend: MockBackend, requests: MockRequest[] = []) {
  return async (path: string, init?: RequestInit): Promise<Response> => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const method = init?.method ?? 'GET';
    requests.push({ path, method, body });
    const url = new URL(path, 'http://localhost');
    const response = backend.handle(method, url.pathname, body, url.searchParams);
    return new Response(response.status === 204 ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** Routes the API client to a MockBackend and renders UI inside the mock project's context. */
export function mockProject(backend = new MockBackend()) {
  const requests: MockRequest[] = [];
  setFetchImplementation(createMockFetch(backend, requests));
  const context: ProjectContextValue = {
    key: 'AC',
    myHandle: 'owner',
    isOwner: true,
    me: {
      ...backend.user,
      handles: { AC: 'owner' },
      projects: [
        {
          key: 'AC',
          name: backend.config.project.name,
          access: 'owner',
          roles: ['operator', 'product_owner'],
        },
      ],
    },
    can: { createTasks: true, manageTeam: true, workInSessions: true },
    search: '',
    setSearch: () => {},
    openNewTask: () => {},
  };
  return {
    backend,
    requests,
    context,
    render: (ui: ReactElement, route = '/', overrides: Partial<ProjectContextValue> = {}) =>
      renderUi(<ProjectContext.Provider value={{ ...context, ...overrides }}>{ui}</ProjectContext.Provider>, {
        route,
      }),
  };
}

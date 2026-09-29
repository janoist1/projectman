import type { ReactElement } from 'react';
import { setFetchImplementation } from '../api/client';
import { ProjectContext } from '../app/contexts';
import type { ProjectContextValue } from '../app/contexts';
import { MockBackend } from '../mocks/backend';
import { renderUi } from './render';

export function mockProject(backend = new MockBackend()) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  setFetchImplementation(async (path, init) => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const method = init?.method ?? 'GET';
    requests.push({ path, method, body });
    const response = backend.handle(method, new URL(path, 'http://localhost').pathname, body);
    return new Response(response.status === 204 ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  });
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

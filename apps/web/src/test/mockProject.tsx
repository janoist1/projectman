import { useState } from 'react';
import { getResponse, HttpHandler } from 'msw';
import type { ReactElement } from 'react';
import { setFetchImplementation } from '../api/client';
import { ProjectContext } from '../app/contexts';
import type { ProjectContextValue } from '../app/contexts';
import { AttachmentUploadsProvider } from '../features/board/attachmentUploads';
import { noBoardFilters } from '../features/board/boardFilters';
import { MockBackend } from '../mocks/backend';
import { renderUi } from './render';
import { server } from './msw/server';
import { defaultTaskHandlers } from './msw/tasks';

export interface MockRequest {
  method: string;
  path: string;
  /** Parsed JSON, malformed JSON as text, or the FormData of an upload. */
  body: unknown;
}

/** A fetch() that answers /api requests from the in-memory backend and records each request. */
export function createMockFetch(backend: MockBackend, requests: MockRequest[] = []) {
  const handlers = defaultTaskHandlers(backend);
  return async (path: string, init?: RequestInit): Promise<Response> => {
    let body: unknown = init?.body instanceof FormData ? init.body : undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body; // The MSW handler records the invalid request, even if the UI handles its 400.
      }
    }
    const method = init?.method ?? 'GET';
    requests.push({ path, method, body });
    const url = new URL(path, 'http://localhost');
    if (!(init?.body instanceof FormData)) {
      const request = new Request(url, { method, headers: init?.headers, body: init?.body });
      const overrides = server
        .listHandlers()
        .filter((handler): handler is HttpHandler => handler instanceof HttpHandler);
      const mocked = await getResponse([...overrides, ...handlers], request);
      if (mocked) return mocked;
    }
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
      instanceOwner: true,
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
    can: {
      createTasks: true,
      manageTeam: true,
      workInSessions: true,
      pauseTeam: true,
      comment: true,
      readConfig: true,
    },
    search: '',
    setSearch: () => {},
    openPause: () => {},
    openPauseDetails: () => {},
    operatorOpen: false,
    openOperator: () => {},
    closeOperator: () => {},
    openNewTask: () => {},
    themeFilter: null,
    setThemeFilter: () => {},
    boardFilters: noBoardFilters,
    setBoardFilters: () => {},
  };
  return {
    backend,
    requests,
    context,
    render: (ui: ReactElement, route = '/', overrides: ContextOverrides = {}) =>
      renderUi(
        <StatefulProject value={{ ...context, ...overrides, can: { ...context.can, ...canOf(overrides) } }}>
          <AttachmentUploadsProvider>{ui}</AttachmentUploadsProvider>
        </StatefulProject>,
        { route },
      ),
  };
}

/** A test names the permissions it cares about; the rest keep the owner's. */
type ContextOverrides = Omit<Partial<ProjectContextValue>, 'can'> & {
  can?: Partial<ProjectContextValue['can']>;
};

/** Pausing the team follows managing it (the same roles), unless a test says otherwise. */
function canOf(overrides: ContextOverrides): Partial<ProjectContextValue['can']> {
  const { can } = overrides;
  if (!can) return {};
  return { ...can, pauseTeam: can.pauseTeam ?? can.manageTeam ?? true };
}

/** The project context with the theme and board filters keeping their state, as the project layout does. */
function StatefulProject({ value, children }: { value: ProjectContextValue; children: ReactElement }) {
  const [themeFilter, setThemeFilter] = useState(value.themeFilter);
  const [boardFilters, setBoardFilters] = useState(value.boardFilters);
  return (
    <ProjectContext.Provider value={{ ...value, themeFilter, setThemeFilter, boardFilters, setBoardFilters }}>
      {children}
    </ProjectContext.Provider>
  );
}

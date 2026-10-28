import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import type { BoardView } from '@projectman/shared';
import { indexMembers } from '../lib/members';
import { indexPipeline } from '../lib/pipeline';
import { MockBackend } from '../mocks/backend';

/** The first location of the test router: a path, or a path with the router state a page was navigated with. */
export type RenderRoute = string | { pathname: string; state?: unknown };

/** Renders UI inside a router and a fresh query client (returned, for tests that push server events). */
export function renderUi(ui: ReactElement, { route = '/' }: { route?: RenderRoute } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </QueryClientProvider>,
    ),
    client,
  };
}

/** Pipeline and member lookups of the mock project, from the board it serves. */
export function mockIndexes() {
  const board = new MockBackend().handle('GET', '/api/projects/AC/board', undefined).body as BoardView;
  return { pipeline: indexPipeline(board), members: indexMembers(board.members) };
}

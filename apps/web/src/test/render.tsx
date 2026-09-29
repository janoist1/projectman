import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { indexMembers } from '../lib/members';
import { indexPipeline } from '../lib/pipeline';
import { buildConfig, members } from '../mocks/fixtures';

/** Renders UI inside a router and a fresh query client. */
export function renderUi(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Pipeline and member lookups of the mock project, as the board builds them. */
export function mockIndexes() {
  const config = buildConfig();
  const pipeline = indexPipeline({
    stages: config.pipeline.stages,
    columns: config.pipeline.columns.map((column) => ({
      ...column,
      stageIds: config.pipeline.stages
        .filter((stage) => stage.columnId === column.id)
        .map((stage) => stage.id),
    })),
  });
  return { pipeline, members: indexMembers(members) };
}

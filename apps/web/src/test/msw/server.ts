import { setupServer } from 'msw/node';

// Handler registry only: createMockFetch resolves requests with getResponse, without interception.
export const server = setupServer();

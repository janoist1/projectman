import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serializeRequest } from './request-logging';

it.each([
  '/hooks/secret-token',
  '/mcp/secret-token',
  '/hooks/secret-token/unknown',
  '/api/invites/secret-token',
  '/api/invites/secret-token/accept',
  '/invite/secret-token',
  '/login?next=%2Finvite%2Fsecret-token',
])('redacts invitation secrets in request logs for %s', async (url) => {
  const lines: string[] = [];
  const app = Fastify({
    logger: {
      serializers: { req: serializeRequest },
      stream: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    },
  });
  app.get('/*', () => ({ ok: true }));
  try {
    await app.inject(url);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain('secret-token');
  } finally {
    await app.close();
  }
});

describe('ordinary request logs', () => {
  it('retains the route and connection information', async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        serializers: { req: serializeRequest },
        stream: {
          write: (line: string) => {
            lines.push(line);
          },
        },
      },
    });
    app.get('/api/projects', () => []);
    try {
      await app.inject('/api/projects');
      expect(lines.map((line) => JSON.parse(line)).find((entry) => entry.req)?.req).toMatchObject({
        method: 'GET',
        url: '/api/projects',
        remoteAddress: '127.0.0.1',
      });
    } finally {
      await app.close();
    }
  });
});

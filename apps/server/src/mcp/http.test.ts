import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { toWebRequest } from './http';

function fake(headers: Record<string, string | string[]>, body: unknown = '{}'): FastifyRequest {
  return { method: 'POST', headers, body } as unknown as FastifyRequest;
}

describe('toWebRequest', () => {
  it('copies the headers and the raw body', async () => {
    const request = toWebRequest(fake({ 'content-type': 'application/json', accept: ['a', 'b'] }, '{"x":1}'));
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('accept')).toBe('a, b');
    expect(await request.text()).toBe('{"x":1}');
  });

  it('leaves out the headers that carry a credential, so they never reach the SDK request info', () => {
    const request = toWebRequest(
      fake({ authorization: 'Bearer pmi_secret', cookie: 'session=x', 'content-type': 'application/json' }),
      ['authorization', 'cookie'],
    );
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('cookie')).toBe(false);
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.url).not.toContain('pmi_');
  });
});

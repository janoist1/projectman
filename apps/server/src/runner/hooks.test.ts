import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { HookPayload } from './hook-payload';
import { isLoopback, isProxied, registerHookRoutes } from './hooks';
import type { ClaudeSession } from './session';
import { silentLogger, waitFor } from './test-helpers';

function fakeSession(answer: (p: HookPayload, withdrawn: AbortSignal) => Promise<unknown>) {
  const calls: HookPayload[] = [];
  const session = {
    id: 'ses_1',
    handleHook: (payload: HookPayload, withdrawn: AbortSignal) => {
      calls.push(payload);
      return answer(payload, withdrawn);
    },
  } as unknown as ClaudeSession;
  return { session, calls };
}

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function appWith(session: ClaudeSession) {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerHookRoutes(app, {
    sessionForToken: (t) => (t === 'good' ? session : undefined),
    logger: silentLogger(),
  });
  return app;
}

describe('POST /hooks/:token', () => {
  it('passes the payload to the session and answers no-ops with an empty 200', async () => {
    const { session, calls } = fakeSession(async () => null);
    const app = appWith(session);
    const res = await app.inject({
      method: 'POST',
      url: '/hooks/good',
      payload: { hook_event_name: 'Stop', session_id: 'x', transcript_path: '/t.jsonl', extra: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(calls[0]).toMatchObject({ hook_event_name: 'Stop', transcript_path: '/t.jsonl', extra: 1 });
  });

  it('rejects rebinding and forwarded callers before parsing their bodies', async () => {
    const { session, calls } = fakeSession(async () => null);
    const app = appWith(session);
    for (const headers of [
      { host: 'evil.example' },
      { origin: 'https://evil.example' },
      { 'x-forwarded-proto': 'https' },
      { 'tailscale-user-login': 'fictional@example.com' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/hooks/good',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: '{invalid',
      });
      expect(res.statusCode).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('enforces the body limit for an authenticated caller', async () => {
    const { session, calls } = fakeSession(async () => null);
    const res = await appWith(session).inject({
      method: 'POST',
      url: '/hooks/good',
      payload: { hook_event_name: 'Stop', extra: 'x'.repeat(32 * 1024 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('answers with the decision JSON', async () => {
    const decision = {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    };
    const { session } = fakeSession(async () => decision);
    const res = await appWith(session).inject({
      method: 'POST',
      url: '/hooks/good',
      payload: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual(decision);
  });

  it('rejects unknown tokens, bad payloads, remote and proxied callers', async () => {
    const { session, calls } = fakeSession(async () => null);
    const app = appWith(session);
    const ok = { hook_event_name: 'Stop' };
    expect((await app.inject({ method: 'POST', url: '/hooks/nope', payload: ok })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/hooks/good', payload: { nope: 1 } })).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/hooks/good', payload: ok, remoteAddress: '100.64.0.7' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/hooks/good',
          payload: ok,
          headers: { 'x-forwarded-for': '100.64.0.7' },
        })
      ).statusCode,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('withdrawn requests', () => {
  it('aborts the pending answer when Claude Code closes the connection', async () => {
    let seen: AbortSignal | null = null;
    const { session } = fakeSession(
      (_payload, withdrawn) =>
        new Promise((resolve) => {
          seen = withdrawn;
          withdrawn.addEventListener('abort', () => resolve(null));
        }),
    );
    const app = appWith(session);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/hooks/good',
      headers: { 'content-type': 'application/json' },
    });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }));
    await waitFor(() => seen !== null, { what: 'hook call' });
    expect(seen!.aborted).toBe(false);
    request.destroy(); // Claude Code stops waiting, e.g. the prompt was answered in the terminal
    await waitFor(() => seen!.aborted, { what: 'withdrawn signal' });
  });
});

describe('address checks', () => {
  it('accepts loopback only', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('192.168.1.10')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
    expect(isProxied({ forwarded: 'for=1.2.3.4' })).toBe(true);
    expect(isProxied({ host: '127.0.0.1:4700' })).toBe(false);
  });
});

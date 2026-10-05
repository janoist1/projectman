import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { HookPayload } from './hook-payload';
import { registerHookRoutes } from './hooks';
import type { AgentSession } from './session';
import { silentLogger, waitFor } from './test-helpers';

function fakeSession(answer: (p: HookPayload, withdrawn: AbortSignal) => Promise<unknown>) {
  const calls: HookPayload[] = [];
  const session = {
    id: 'ses_1',
    handleHook: (payload: HookPayload, withdrawn: AbortSignal) => {
      calls.push(payload);
      return answer(payload, withdrawn);
    },
  } as unknown as AgentSession;
  return { session, calls };
}

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function parse(_session: AgentSession, body: unknown): HookPayload | null {
  const parsed = HookPayload.safeParse(body);
  return parsed.success ? parsed.data : null;
}

function appWith(session: AgentSession, sessionForToken?: (token: string) => AgentSession | undefined) {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerHookRoutes(app, {
    sessionForToken: sessionForToken ?? ((t) => (t === 'good' ? session : undefined)),
    parse,
    logger: silentLogger(),
  });
  return app;
}

describe('POST /hooks/:token', () => {
  it('passes validated URL events through the same local guards', async () => {
    const { session, calls } = fakeSession(async () => ({ decision: 'allow' }));
    const app = Fastify({ logger: false });
    apps.push(app);
    registerHookRoutes(app, {
      sessionForToken: (token) => (token === 'good' ? session : undefined),
      parse: (_s, body, event) => ({ hook_event_name: event!, ...(body as object) }),
      logger: silentLogger(),
    });
    expect((await app.inject({ method: 'POST', url: '/hooks/good/PreToolUse', payload: {} })).json()).toEqual(
      { decision: 'allow' },
    );
    expect(calls[0]!.hook_event_name).toBe('PreToolUse');
    expect((await app.inject({ method: 'POST', url: '/hooks/good/Bad123', payload: {} })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'POST', url: '/hooks/missing/Stop', payload: {} })).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/hooks/good/Stop',
          headers: { host: 'evil.example' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
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

  it('looks the token up again once the body has arrived', async () => {
    const { session, calls } = fakeSession(async () => null);
    // The session exits while the body is on its way: the second lookup finds nothing.
    let lookups = 0;
    const app = appWith(session, (t) => (t === 'good' && ++lookups === 1 ? session : undefined));
    const res = await app.inject({
      method: 'POST',
      url: '/hooks/good',
      payload: { hook_event_name: 'Stop' },
    });
    expect(res.statusCode).toBe(404);
    expect(lookups).toBe(2);
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

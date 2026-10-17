import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_EXIT, CreatedIntegratorAccessKey, routes } from '@projectman/shared';
import { main } from '../../../scripts/projectman/cli';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import {
  createClientHome,
  createTestIo,
  type ClientHome,
  type TestIoOptions,
} from './helpers/projectman-client';

/** The client against the real application: a fetch that goes through `inject`. */
function injectFetch(h: AppHarness): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[name.toLowerCase()] = value;
    const response = await h.app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers,
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    const bodyless = [101, 204, 205, 304].includes(response.statusCode);
    return new Response(bodyless ? null : response.body, {
      status: response.statusCode,
      headers: { 'content-type': String(response.headers['content-type'] ?? 'application/json') },
    });
  }) as typeof fetch;
}

describe('projectman CLI against the server (PM-765)', () => {
  let h: AppHarness;
  let fx: ClientHome;
  let cookie: string;
  let userId: string;
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    userId = h.app.projectman.repos.users.list()[0]!.id;
    h.app.projectman.domain.superHandoffs.registerExecutor('operate', async () => {});
    fx = createClientHome({ baseUrl: 'http://localhost:4700' });
  });
  afterEach(async () => {
    fx.cleanup();
    await h.close();
  });

  const useKey = async (mode: 'super' | 'read'): Promise<string> => {
    const created = await h.app.inject({
      method: 'POST',
      url: routes.integratorKeys(),
      headers: { cookie },
      payload: { mode },
    });
    const { secret } = CreatedIntegratorAccessKey.parse(created.json());
    fs.writeFileSync(fx.keyFile, `${secret}\n`);
    return secret;
  };
  const channelOf = () => h.app.projectman.auth.integratorAccessKeys(userId).at(-1)?.lastUsedChannel;
  const run = async (args: string[], options: TestIoOptions = {}) => {
    const t = createTestIo(fx.home, () => new Response(null, { status: 500 }), options);
    t.io.fetch = injectFetch(h);
    const code = await main(args, t.io);
    return { code, out: t.stdout.join(''), err: t.stderr.join('') };
  };

  it('a super key creates a card, sends a message and reads the operation; the use counts as the CLI channel', async () => {
    const secret = await useKey('super');
    const created = await run(['tasks', 'create', '--project', 'AR', '--file', '-', '--json'], {
      stdin: JSON.stringify({ title: 'From the command line', description: 'one\n\ntwo' }),
    });
    expect(created.code, created.err).toBe(CLIENT_EXIT.ok);
    expect(JSON.parse(created.out)).toMatchObject({
      title: 'From the command line',
      description: 'one\n\ntwo',
    });
    expect(channelOf()).toBe('cli');

    const sent = await run(
      ['messages', 'send', '--project', 'AR', '--to', 'claude', '--file', '-', '--json'],
      {
        stdin: 'Please look at this.\n',
      },
    );
    expect(sent.code, sent.err).toBe(CLIENT_EXIT.ok);
    const operation = JSON.parse(sent.out).operation as { id: string; state: string };
    expect(operation.state).toBe('succeeded');

    const read = await run(['operations', 'get', operation.id, '--project', 'AR']);
    expect(read.code, read.err).toBe(CLIENT_EXIT.ok);
    expect(read.out).toBe(`operation ${operation.id} succeeded\n`);

    const missing = await run(['operations', 'get', 'sop_missing', '--project', 'AR']);
    expect(missing.code).toBe(CLIENT_EXIT.failed);
    expect(missing.err).toContain('not_found');
    expect(`${created.out}${created.err}${sent.out}${sent.err}${read.out}${missing.err}`).not.toContain(
      secret,
    );
  });

  it('reads the inbox and counts the use as the CLI channel', async () => {
    await useKey('super');
    const inbox = await run(['inbox', 'list', '--project', 'AR', '--json']);
    expect(inbox.code, inbox.err).toBe(CLIENT_EXIT.ok);
    expect(JSON.parse(inbox.out)).toEqual({ items: [] });
    expect(channelOf()).toBe('cli');
  });

  it('a read key reads, and every change is refused by the server as before', async () => {
    const secret = await useKey('read');
    expect((await run(['inbox', 'list', '--project', 'AR'])).code).toBe(CLIENT_EXIT.ok);
    for (const args of [
      ['tasks', 'create', '--project', 'AR', '--file', '-'],
      ['messages', 'send', '--project', 'AR', '--to', 'claude', '--file', '-'],
      ['pause', '--project', 'AR'],
    ]) {
      const refused = await run(args, { stdin: '{"title":"x"}' });
      expect(refused.code, args.join(' ')).toBe(CLIENT_EXIT.failed);
      expect(refused.err, args.join(' ')).toContain('integrator_read_only');
      expect(refused.err).not.toContain(secret);
    }
  });

  it('a key the server does not know ends with status 3', async () => {
    fs.writeFileSync(fx.keyFile, 'pmi_thisKeyWasNeverIssued1234567890\n');
    const refused = await run(['inbox', 'list', '--project', 'AR']);
    expect(refused.code).toBe(CLIENT_EXIT.auth);
    expect(refused.err).toContain('integrator_key_invalid');
    expect(refused.err).not.toContain('pmi_thisKeyWasNeverIssued1234567890');
  });

  it('the proxy reaches /mcp with the same key, and the server counts it as the MCP channel', async () => {
    await useKey('super');
    const request = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
    const proxied = await run(['mcp-proxy'], { stdin: `${JSON.stringify(request)}\n` });
    // The test application serves no MCP route (the server's own tests cover the endpoint): the key was
    // accepted, the proxy answered the request with an error line, and the use is the MCP channel.
    expect(channelOf()).toBe('mcp');
    expect(
      proxied.out
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).id),
    ).toEqual([1]);
    expect(proxied.code).toBe(CLIENT_EXIT.failed);
  });
});

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceApiError, startInstance } from '../../../scripts/lib/instance.mjs';
import type { Instance } from '../../../scripts/lib/instance.mjs';

/**
 * scripts/lib/instance.mjs (PM-269): real servers and Vite on free ports, the fake CLIs, no
 * pseudo-terminal, so these run in a member's sandbox too.
 */
const SLOW = 120_000;
const parentScript = fileURLToPath(new URL('./fixtures/instance-parent.mjs', import.meta.url));
const running: Instance[] = [];

async function start(options: Parameters<typeof startInstance>[0] = {}): Promise<Instance> {
  const instance = await startInstance({ web: false, ...options });
  running.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((instance) => instance.stop()));
});

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

describe('startInstance', () => {
  it('refuses the live data, the live port and foreign environment names', async () => {
    await expect(startInstance({ dir: join(homedir(), '.projectman', 'instance-test') })).rejects.toThrow(
      /below ~\/\.projectman/,
    );
    await expect(startInstance({ ports: { server: 4800 } })).rejects.toThrow(/live instance/);
    await expect(startInstance({ ports: { web: 4800 } })).rejects.toThrow(/live instance/);
    await expect(startInstance({ fakeEnv: { ANTHROPIC_API_KEY: 'x' } })).rejects.toThrow(/FAKE_CLAUDE_/);
    await expect(startInstance({ fakeEnv: { PROJECTMAN_HOME: '/x' } })).rejects.toThrow(/FAKE_CLAUDE_/);
  });

  it(
    'runs two instances at once on their own ports and data, and leaves nothing after stop',
    async () => {
      const [a, b] = await Promise.all([start({ seed: 'none' }), start({ web: true })]);
      expect(a.serverUrl).not.toBe(b.serverUrl);
      expect(a.dir).not.toBe(b.dir);
      expect(a.webUrl).toBeNull();
      expect(b.webUrl).not.toBeNull();
      expect(await a.api('/api/projects')).toEqual([]);
      expect((await b.api('/api/projects')).map((project: { key: string }) => project.key)).toEqual(['AC']);
      expect((await fetch(`${b.webUrl}/api/setup`)).ok).toBe(true);
      const urls = [a.serverUrl, b.serverUrl, b.webUrl!];
      await Promise.all([a.stop(), b.stop()]);
      await a.stop();
      expect(existsSync(a.dir) || existsSync(b.dir)).toBe(false);
      for (const url of urls) expect(await answers(url)).toBe(false);
    },
    SLOW,
  );

  it(
    'keeps a directory it was given',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'projectman-instance-test-'));
      try {
        const instance = await start({ dir, seed: 'none' });
        await instance.stop();
        expect(existsSync(join(dir, 'logs', 'server.log'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it(
    'logs a non-admin account in with an invitation',
    async () => {
      const instance = await start();
      const client = await instance.invite({
        project: 'AC',
        email: 'Client@Acme.test',
        name: 'Cleo Client',
        access: 'client',
      });
      expect(client).toEqual({ email: 'client@acme.test', name: 'Cleo Client' });
      expect(JSON.stringify(client)).not.toMatch(/password/i);
      const me = await instance.api('/api/me', { as: client });
      expect(me.email).toBe('client@acme.test');
      expect(me.projects[0].access).toBe('client');
      await expect(
        instance.api('/api/projects/AC/invites', {
          method: 'POST',
          body: { email: 'x@acme.test', access: 'viewer', roles: [] },
          as: client,
        }),
      ).rejects.toSatisfy((err) => err instanceof InstanceApiError && err.status === 403);
    },
    SLOW,
  );

  it(
    'gives a browser login as a storageState: the session cookie only, no password',
    async () => {
      const instance = await start();
      const client = await instance.invite({
        project: 'AC',
        email: 'cookie@acme.test',
        name: 'Cora Cookie',
        access: 'client',
      });
      const state = await instance.storageState(client);
      expect(state.origins).toEqual([]);
      expect(state.cookies).toHaveLength(1);
      const [cookie] = state.cookies;
      expect(cookie).toMatchObject({ name: 'pm_session', domain: '127.0.0.1', path: '/', httpOnly: true });
      const me = await fetch(`${instance.serverUrl}/api/me`, {
        headers: { cookie: `${cookie!.name}=${cookie!.value}` },
      });
      expect((await me.json()).email).toBe('cookie@acme.test');
      expect((await instance.storageState()).cookies[0]!.value).not.toBe(cookie!.value);
      expect(JSON.stringify(state)).not.toMatch(/password/i);
    },
    SLOW,
  );

  it(
    'shows the fake lead’s ask_human question in the inbox',
    async () => {
      const instance = await start();
      const members = await instance.api('/api/projects/AC/members');
      const developer = members.find(
        (member: { kind: string; role: string }) => member.kind === 'ai' && member.role === 'developer',
      );
      const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
      await instance.waitIdle('AC', sessionId);
      await instance.setFakeCalls([
        { tool: 'ask_human', arguments: { question: 'Which colour should the basket button be?' } },
      ]);
      await instance.say('AC', sessionId, 'CALLS please');
      await instance.waitIdle('AC', sessionId);
      const inbox = await instance.api('/api/projects/AC/inbox');
      expect(JSON.stringify(inbox)).toContain('Which colour should the basket button be?');
    },
    SLOW,
  );

  it(
    'leaves no child process after the parent is killed with SIGKILL',
    async () => {
      const parent = spawn(process.execPath, [parentScript], { stdio: ['ignore', 'pipe', 'inherit'] });
      let dir: string | undefined;
      try {
        const line = await new Promise<string>((resolve, reject) => {
          let text = '';
          parent.stdout.on('data', (chunk) => {
            text += chunk;
            if (text.includes('\n')) resolve(text);
          });
          parent.once('exit', () => reject(new Error('The parent exited before it was ready.')));
        });
        const started = JSON.parse(line) as { serverUrl: string; webUrl: string; dir: string };
        const { serverUrl, webUrl } = started;
        dir = started.dir;
        expect(await answers(serverUrl)).toBe(true);
        expect(await answers(webUrl)).toBe(true);
        parent.kill('SIGKILL');
        expect(await waitUntil(async () => !(await answers(serverUrl)), 20_000)).toBe(true);
        expect(await waitUntil(async () => !(await answers(webUrl)), 20_000)).toBe(true);
      } finally {
        parent.kill('SIGKILL');
        // A killed parent cannot remove its temporary directory.
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});

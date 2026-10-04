import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routes } from '@projectman/shared';
import type { AgentProvider, Task, TaskDetail } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';
import { pngBytes, uploadFile } from './helpers/attachments';

/**
 * What a task session may do with the task's attachment directory, as the real runner gives it to
 * the fake CLIs, on a new and on a resumed session: Claude Code reads it without asking and never
 * edits it (rules, not an extra working directory); Codex gets nothing for it (its sandbox reads
 * and never writes there), and in particular no writable root. Neither gets the server's home.
 */

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const PROVIDERS: Array<[AgentProvider, string]> = [
  ['claude', 'dev-1'],
  ['codex', 'dev-2'],
];

interface Started {
  argv: string[];
  config?: Record<string, unknown>;
}

it.each(PROVIDERS)(
  'gives a new and a resumed %s session read access to its task’s attachments only',
  { timeout: 90_000 },
  async (provider, member) => {
    h = await createAppHarness({ runner: 'fake-cli' });
    const { app, home } = h;
    const argsFile = join(home, `${provider}-args.json`);
    vi.stubEnv(provider === 'codex' ? 'FAKE_CODEX_ARGS_FILE' : 'FAKE_CLAUDE_ARGS_FILE', argsFile);
    const started = (): Started => JSON.parse(readFileSync(argsFile, 'utf8'));
    const cookie = await setupOwner(app);
    await createProject(h, cookie);
    const { domain } = app.projectman;
    await domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
      (config) => {
        const dev = config.team.members.find((m) => m.handle === member);
        if (dev?.kind === 'ai') dev.provider = provider;
        return `Run ${member} on ${provider}`;
      },
    );
    const created = await app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers: { cookie },
      payload: { title: 'Acme checkout' },
    });
    const { key } = created.json<Task>();
    expect(
      (await uploadFile(app, cookie, pngBytes(), { taskKey: key, fileName: 'mockup.png' })).statusCode,
    ).toBe(201);
    const dir = join(home, 'attachments', 'AR', key);

    const start = async () => {
      const res = await app.inject({
        method: 'POST',
        url: routes.startTask('AR', key),
        headers: { cookie },
        payload: { assignee: member },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<TaskDetail>().sessions[0]!;
    };
    const check = (resumed: boolean) => {
      const { argv, config } = started();
      if (provider === 'claude') {
        expect(argv.includes('--resume')).toBe(resumed);
        const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!);
        expect(settings.permissions.allow).toContain(`Read(/${dir}/**)`);
        expect(settings.permissions.deny).toContain(`Edit(/${dir}/**)`);
        // Not an extra working directory: in acceptEdits mode its files would be editable.
        expect(
          argv.filter((arg, i) => argv[i - 1] === '--add-dir' && arg.startsWith(join(home, 'attachments'))),
        ).toEqual([]);
      } else {
        expect(argv[0] === 'resume').toBe(resumed);
        expect(JSON.stringify(argv)).not.toContain(join(home, 'attachments'));
        expect(JSON.stringify(config ?? {})).not.toContain(join(home, 'attachments'));
      }
      // Never the whole server home: no rule or root names it, apart from the task's own directory.
      // The sandbox's `denyRead` and `denyWrite` close the home (PM-153): a prohibition may name it,
      // so those two lists are left out; everything else (`permissions.allow`, `allowRead`,
      // `allowWrite`, `--add-dir`, any other argument) is checked as before.
      const granting = argv.map((arg, i) => {
        if (argv[i - 1] !== '--settings') return arg;
        const settings = JSON.parse(arg);
        const opened = { ...settings.sandbox?.filesystem };
        delete opened.denyRead;
        delete opened.denyWrite;
        return JSON.stringify({
          ...settings,
          ...(settings.sandbox ? { sandbox: { ...settings.sandbox, filesystem: opened } } : {}),
        });
      });
      const homePattern = new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"\\s)*]*`, 'g');
      const named = granting
        .flatMap((arg) => arg.match(homePattern) ?? [])
        .map((path) => path.replace(/\/+$/, ''));
      for (const path of named)
        expect(path === dir || !path.startsWith(join(home, 'attachments')), path).toBe(true);
      expect(named).not.toContain(home);
    };

    const first = await start();
    await waitFor(() => domain.sessions.get('AR', first.id).transcriptPath, { what: 'a transcript' });
    // The startup idle state precedes the first input. Only a completed turn proves a conversation exists.
    await vi.waitFor(
      async () => {
        const { chat } = await domain.sessions.detail('AR', first.id);
        expect(chat.some((i) => i.kind === 'assistant_text')).toBe(true);
      },
      { timeout: 20_000 },
    );
    await waitFor(() => domain.sessions.get('AR', first.id).state === 'idle', { what: 'idle' });
    check(false);

    await domain.sessions.stop('AR', first.id);
    await waitFor(() => !app.projectman.runnerModule.runner.isRunning(first.id), {
      what: 'the session to stop',
    });
    const resumed = await start();
    expect(resumed.id).toBe(first.id);
    await waitFor(() => started().argv.includes(provider === 'claude' ? '--resume' : 'resume'), {
      what: 'the resumed process',
    });
    check(true);
  },
);

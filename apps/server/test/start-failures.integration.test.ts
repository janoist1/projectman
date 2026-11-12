import { afterEach, expect, it, vi } from 'vitest';
import { humanActor } from '../src/kernel';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

/**
 * A session start that fails the way a real CLI does, through the real runner and the fake Codex: the
 * process exits with 1 before its first turn, the session ends as a failed start and the place backs off.
 */

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  vi.unstubAllEnvs();
});

it(
  'counts a Codex session that exits before its first turn once and keeps its start waiting (PM-1335)',
  { timeout: 60_000 },
  async () => {
    vi.stubEnv('FAKE_CODEX_EXIT_AT_START', '1');
    h = await createAppHarness({ runner: 'fake-cli' });
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const { domain, runnerModule, repos } = h.app.projectman;
    const actor = humanActor('owner');
    await domain.projects.update('AR', { actor, author: OWNER_LOGIN }, (config) => {
      const member = config.team.members.find((m) => m.handle === 'dev-1');
      if (member?.kind === 'ai') member.provider = 'codex';
      return 'Run dev-1 on codex';
    });
    const task = await domain.tasks.create('AR', { title: 'A start that fails' }, actor);
    await domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Start this task', taskKey: task.key });

    // The process exits before its first turn: the session end counts it, once.
    await waitFor(() => repos.startFailures.list()[0], { what: 'a counted failed start' });
    expect(repos.startFailures.list()).toHaveLength(1);
    expect(repos.startFailures.list()[0]).toMatchObject({ member: 'dev-1', failures: 1, stoppedAt: null });

    // The first message was delivered when the session started. The next one waits with the backoff
    // instead of starting a session again.
    const sessions = domain.sessions.list('AR', { member: 'dev-1', taskKey: task.key });
    await domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Try once more', taskKey: task.key });
    await vi.waitFor(
      () => {
        expect(repos.memberQueue.listOpen('AR', 'dev-1').map((item) => item.wait?.code)).toContain(
          'start_backoff',
        );
      },
      { timeout: 20_000 },
    );
    expect(runnerModule.runner.list()).toEqual([]);
    expect(repos.startFailures.list()[0]).toMatchObject({ failures: 1 });
    expect(domain.sessions.list('AR', { member: 'dev-1', taskKey: task.key })).toHaveLength(sessions.length);
  },
);

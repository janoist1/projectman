import { routes } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { afterEach, expect, it } from 'vitest';
import { humanActor } from '../src/domain';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it(
  'starts a hand-over deferred while AI was off in a fake Claude session after a server restart and AI on',
  { timeout: 60_000 },
  async () => {
    h = await createAppHarness({ runner: 'fake-cli', real: { context: true } });
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const setAi = async (aiEnabled: boolean) => {
      const { version } = await h!.app.projectman.domain.projects.load('AR');
      const res = await h!.app.inject({
        method: 'PATCH',
        url: routes.config('AR'),
        headers: { cookie },
        payload: { baseVersion: version, limits: { aiEnabled } },
      });
      expect(res.statusCode).toBe(200);
    };

    await setAi(false);
    const created = await h.app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers: { cookie },
      payload: { title: 'Acme checkout' },
    });
    const { key } = created.json<Task>();
    await h.app.projectman.domain.tasks.moveToStage('AR', key, 'code_review', humanActor('owner'));
    const waiting = await waitFor(() => h!.app.projectman.domain.tasks.get('AR', key).startWaiting, {
      what: 'the deferred hand-over',
    });
    expect(waiting).toMatchObject({ reason: 'ai_disabled', member: 'cr' });
    expect(h.app.projectman.repos.deferredStarts.list().map((r) => r.key)).toEqual(['hand-over:AR:AR-1']);

    // The server stops and starts again over the same database: the start was not lost.
    await h.restart();
    const { domain, runnerModule } = h.app.projectman;
    expect(domain.tasks.get('AR', key).startWaiting).toEqual(waiting);
    expect(runnerModule.runner.list()).toEqual([]);

    await setAi(true);
    const session = await waitFor(
      () => domain.sessions.list('AR', { member: 'cr', taskKey: key }).find((s) => s.state === 'idle'),
      { what: 'the reviewer session of the fake Claude' },
    );
    expect(runnerModule.runner.isRunning(session.id)).toBe(true);
    expect(domain.tasks.get('AR', key).startWaiting).toBeUndefined();
    expect(h.app.projectman.repos.deferredStarts.list()).toEqual([]);
  },
);

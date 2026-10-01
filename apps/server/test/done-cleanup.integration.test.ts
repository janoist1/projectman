import { routes } from '@projectman/shared';
import type { Task, TaskDetail } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

/**
 * The session that moves its own task to done (PM-190), through the real runner, the team MCP
 * endpoint and the fake Claude Code CLI: in one turn it moves the task to done and then sends a
 * message. The done cleanup (no delay in the harness) leaves it its turn: the message arrives, and
 * the session stops when the turn is over.
 */

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const NOTES = 'Five notes that do not block the merge';

it(
  'lets the session that moved its task to done finish the turn, then stops it',
  { timeout: 90_000 },
  async () => {
    h = await createAppHarness({ runner: 'fake-cli' });
    const { app } = h;
    const cookie = await setupOwner(app);
    const headers = { cookie };
    await createProject(h, cookie);
    const { domain, repos, runnerModule } = app.projectman;
    let doneStage = '';
    await domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
      (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev?.kind === 'ai') dev.provider = 'claude';
        // Straight to done: no gates, no release stage.
        for (const stage of config.pipeline.stages) delete stage.gate;
        config.pipeline.stages = config.pipeline.stages.filter((s) => s.kind !== 'release');
        doneStage = config.pipeline.stages.find((s) => s.kind === 'done')!.id;
        return 'Run dev-1 on claude, without gates';
      },
    );
    // The send comes well after the cleanup would have stopped the session before PM-190.
    vi.stubEnv(
      'FAKE_CLAUDE_MCP_CALLS',
      JSON.stringify([
        { tool: 'update_task', arguments: { task_key: 'AR-1', stage_id: doneStage } },
        { tool: 'send_message', arguments: { to: ['owner'], text: NOTES }, delayMs: 500 },
      ]),
    );
    const created = await app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers,
      payload: { title: 'Acme checkout', repo: 'web' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<Task>().key).toBe('AR-1');
    const started = await app.inject({
      method: 'POST',
      url: routes.startTask('AR', 'AR-1'),
      headers,
      payload: { assignee: 'dev-1' },
    });
    expect(started.statusCode).toBe(200);
    const sessionId = started.json<TaskDetail>().sessions[0]!.id;
    const session = () => domain.sessions.get('AR', sessionId);
    const said = (text: string | RegExp) =>
      vi.waitFor(
        async () => {
          const { chat } = await domain.sessions.detail('AR', sessionId);
          expect(chat.some((i) => i.kind === 'assistant_text' && String(i.text).match(text))).toBe(true);
        },
        { timeout: 20_000 },
      );

    // The brief's turn first, then the turn that moves the task and writes afterwards.
    await said(/^Echo: /);
    await waitFor(() => session().state === 'idle', { what: 'the brief turn to end', timeoutMs: 20_000 });
    const typed = await app.inject({
      method: 'POST',
      url: routes.sessionMessages('AR', sessionId),
      headers,
      payload: { text: 'CALLS' },
    });
    expect(typed.statusCode, typed.body).toBe(202);

    await waitFor(() => repos.messages.list('AR').find((m) => m.body === NOTES), {
      what: 'the message sent after the move',
      timeoutMs: 20_000,
    });
    expect(repos.tasks.get('AR-1')).toMatchObject({ status: 'done' });
    await waitFor(() => session().state === 'exited', { what: 'the session to stop', timeoutMs: 20_000 });
    expect(runnerModule.runner.isRunning(sessionId)).toBe(false);
    // It stopped after its turn: the reply that ends the turn is in the transcript.
    await said('Echo: CALLS');
    expect(repos.messages.list('AR').find((m) => m.body === NOTES)).toMatchObject({
      from: 'dev-1',
      to: ['owner'],
      taskKey: 'AR-1',
    });
  },
);

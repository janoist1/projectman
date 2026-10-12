import { afterEach, expect, it, vi } from 'vitest';
import { memberOf } from '@projectman/shared';
import type { AiMemberConfig } from '@projectman/shared';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it(
  'starts Devops through the fake Claude CLI with the cardless task as its first input',
  { timeout: 30_000 },
  async () => {
    h = await createAppHarness({
      runner: 'fake-cli',
      real: { context: true },
      app: { shutdownPauseMs: 0, claudeTmpRoots: [] },
    });
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const domain = h.app.projectman.domain;
    await domain.projects.update(
      'AR',
      {
        actor: { kind: 'human', handle: 'owner' },
        author: OWNER_LOGIN,
      },
      (config) => {
        config.team.members.push({
          ...(memberOf(config, 'dev-1') as AiMemberConfig),
          handle: 'devops',
          displayName: 'Devops',
          role: 'devops',
          provider: 'claude',
        });
        return 'Add Devops';
      },
    );
    const ownerMessage = await domain.messaging.sendReporting(
      'AR',
      'owner',
      {
        to: ['operator'],
        text: 'SLOW Check the engine with Devops.',
      },
      { awaitWake: true },
    );
    expect(ownerMessage.recipients[0]!.start?.state).toBe('started');
    const operator = domain.sessions.list('AR', { member: 'operator' })[0]!;
    const text = 'Inspect the engine readiness without a card.';
    const result = await domain.teamTools.startMember(
      {
        projectKey: 'AR',
        member: 'operator',
        sessionId: operator.id,
        taskKey: null,
      },
      { member: 'devops', text },
    );
    const session = domain.sessions.list('AR', { member: 'devops' })[0]!;
    expect(session.workItem).toEqual({ type: 'general' });
    expect(result.recipient).toEqual({
      handle: 'devops',
      delivery: 'wake',
      start: { state: 'started', sessionId: session.id },
    });
    await vi.waitFor(
      async () => {
        const chat = (await domain.sessions.detail('AR', session.id)).chat;
        const inputs = chat.filter(
          (i) => i.kind === 'user_text' || (i.kind === 'team_message' && i.direction === 'in'),
        );
        expect(inputs[0]).toMatchObject({ text: expect.stringContaining(text) });
        expect(chat.some((i) => i.kind === 'assistant_text')).toBe(true);
      },
      { timeout: 15_000 },
    );
    const request = domain.ctx.repos.operatorRequests.latest('AR', 1)[0]!;
    expect(domain.ctx.repos.operatorRequests.steps(request.id)).toMatchObject([
      { action: 'task_start', taskKey: null, member: 'devops', status: 'done' },
    ]);
  },
);

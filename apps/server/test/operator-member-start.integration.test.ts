import { waitForSession } from './helpers/domain-harness';
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
        (memberOf(config, 'pm') as AiMemberConfig).onLeave = false;
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
        to: ['pm'],
        text: 'SLOW Check the engine with Devops.',
      },
      { awaitWake: true },
    );
    expect(ownerMessage.recipients[0]!.start?.state).toBe('started');
    const operator = await waitForSession(domain, { member: 'pm' });
    // The fake CLI finishes the owner's turn itself. Open a request fixture after that turn,
    // so the tool call does not race the Stop hook that closes the original request.
    await vi.waitFor(
      () => {
        expect(domain.sessions.get('AR', operator.id).state).toBe('idle');
        expect(domain.ctx.repos.operatorRequests.openOfSession(operator.id)).toEqual([]);
      },
      { timeout: 15_000 },
    );
    const requestId = 'opr_member_start';
    domain.ctx.repos.operatorRequests.insert({
      id: requestId,
      projectKey: 'AR',
      sessionId: operator.id,
      source: 'message',
      messageId: ownerMessage.message.id,
      inboxItemId: null,
      fromHandle: 'owner',
      quote: 'Check the engine with Devops.',
      openedAt: new Date().toISOString(),
    });
    expect(domain.ctx.repos.operatorRequests.openOfSession(operator.id)).toHaveLength(1);
    const text = 'Inspect the engine readiness without a card.';
    const result = await domain.teamTools.startMember(
      {
        projectKey: 'AR',
        member: 'pm',
        sessionId: operator.id,
        taskKey: null,
      },
      { member: 'devops', text },
    );
    const session = await waitForSession(domain, { member: 'devops' });
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
    // Replies may open newer Operator requests; this start belongs to the request captured at the call.
    expect(domain.messages.get(result.messageId)?.operatorRequest).toBe(requestId);
    expect(domain.ctx.repos.operatorRequests.steps(requestId)).toMatchObject([
      { action: 'task_start', taskKey: null, member: 'devops', status: 'done' },
    ]);
  },
);

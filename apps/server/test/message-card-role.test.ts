import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiMemberConfig, ProjectConfig } from '@projectman/shared';
import { aiActor, SYSTEM_ACTOR } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

const DEVELOPERS = ['dev-2', 'dev-3', 'dev-4', 'dev-5', 'dev-6', 'dev-7', 'dev-8'];

/** The test project with more developers in the work stage, an architect, a designer and a security reviewer. */
function widen(config: ProjectConfig) {
  // The schema's defaults fill the rest when the harness reads the configuration.
  const ai = (handle: string, role: string) =>
    ({ kind: 'ai', handle, displayName: handle, role, sponsor: 'owner' }) as AiMemberConfig;
  const extra = [
    ...DEVELOPERS.slice(1).map((handle) => ai(handle, 'developer')),
    ai('arch', 'architect'),
    ai('arch-2', 'architect'),
    ai('ux', 'designer'),
    ai('sec', 'security_review'),
  ];
  config.team.members.push(...extra);
  const work = config.pipeline.stages.find((stage) => stage.kind === 'work')!;
  work.owners = ['dev-1', ...DEVELOPERS];
}

describe('a message from an AI member starts only members with a role on the card (PM-426)', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const sessionsOf = (member: string) => h.domain.sessions.list('AR', { member });

  it('starts none of seven developers without a role on the card, and asks no review round of them', async () => {
    h = await createDomainHarness({ adjust: widen });
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', {
      actor: OWNER_ACTOR,
      author: { name: 'Owner', email: 'owner@example.com' },
    });
    const rounds = vi.spyOn(h.domain.sessions, 'requestReviewRound');
    const before = h.runner.started.length;
    const result = await h.domain.teamTools.sendMessage(
      { projectKey: 'AR', taskKey: 'AR-1', member: 'dev-1', sessionId: started.session!.id },
      { to: DEVELOPERS, text: 'Ready for developer review and integration.', kind: 'action' },
    );
    await flush();
    expect(result.recipients).toEqual(
      DEVELOPERS.map((handle) => ({ handle, delivery: 'next_input', noWake: 'no_card_role' })),
    );
    expect(h.runner.started).toHaveLength(before);
    expect(rounds).not.toHaveBeenCalled();
    for (const handle of DEVELOPERS) expect(sessionsOf(handle)).toEqual([]);
    // The messages are not lost: each waits for the next time its recipient works on the card.
    for (const handle of DEVELOPERS) expect(h.repos.messages.pending('AR', handle)).toHaveLength(1);
  });

  it('starts the assignee, the stage owner, the reviewers and a worker of the card or its parent', async () => {
    h = await createDomainHarness({ adjust: widen });
    const parent = await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const child = await h.domain.tasks.create('AR', { title: 'Cart', parentKey: parent.key }, OWNER_ACTOR);
    // The architect planned on the parent card; the other architect did not work on the family.
    await h.domain.sessions.ensureSession('AR', 'arch', { type: 'task', taskKey: parent.key });
    h.domain.tasks.assign('AR', child.key, 'dev-2', OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', child.key, 'code_review', OWNER_ACTOR);
    await flush();
    const recipients = ['dev-2', 'cr', 'sec', 'ux', 'arch', 'dev-3', 'arch-2'];
    const rounds = vi.spyOn(h.domain.sessions, 'requestReviewRound');
    const result = await h.domain.messaging.sendReporting(
      'AR',
      'dev-2',
      { to: recipients.filter((handle) => handle !== 'dev-2'), text: 'Please look.', taskKey: child.key },
      { actor: aiActor('dev-2') },
    );
    const delivery = Object.fromEntries(result.recipients.map((r) => [r.handle, r.noWake ?? r.delivery]));
    // A session that already runs takes the message in its turn; one that does not is started.
    expect(delivery).toMatchObject({ cr: 'after_turn', arch: 'after_turn', sec: 'wake', ux: 'wake' });
    expect(delivery['dev-3']).toBe('no_card_role');
    expect(delivery['arch-2']).toBe('no_card_role');
    // A round is asked of the ones with a role only.
    expect(rounds.mock.calls.map((call) => call[2]).sort()).toEqual(['arch', 'cr', 'sec', 'ux']);
    // The assignee is woken by another AI member's message too.
    const back = await h.domain.messaging.sendReporting(
      'AR',
      'cr',
      { to: ['dev-2'], text: 'Fix this.', taskKey: child.key },
      { actor: aiActor('cr') },
    );
    expect(back.recipients[0]!.noWake).toBeUndefined();
    expect(back.recipients[0]!.delivery).not.toBe('next_input');
  });

  it('a person, the integrator and the system start a member without a role', async () => {
    h = await createDomainHarness({ adjust: widen });
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const person = await h.domain.messaging.sendReporting('AR', 'owner', {
      to: ['dev-2'],
      text: 'Please take a look.',
      taskKey: 'AR-1',
    });
    expect(person.recipients).toEqual([{ handle: 'dev-2', delivery: 'wake' }]);
    const integrator = await h.domain.messaging.sendReporting(
      'AR',
      'owner',
      { to: ['dev-3'], text: 'Integrator here.', taskKey: 'AR-1' },
      { actor: { ...OWNER_ACTOR, via: 'integrator' } },
    );
    expect(integrator.recipients).toEqual([{ handle: 'dev-3', delivery: 'wake' }]);
    const system = await h.domain.messaging.sendReporting(
      'AR',
      'system',
      { to: ['dev-4'], text: 'A permission request waits.', taskKey: 'AR-1' },
      { actor: SYSTEM_ACTOR },
    );
    expect(system.recipients).toEqual([{ handle: 'dev-4', delivery: 'wake' }]);
    // A message about no card is the general chat: the role does not apply.
    const general = await h.domain.messaging.sendReporting('AR', 'dev-1', {
      to: ['dev-5'],
      text: 'A question.',
    });
    expect(general.recipients).toEqual([{ handle: 'dev-5', delivery: 'wake' }]);
  });

  it('a waiting message starts nothing until its recipient becomes the assignee', async () => {
    h = await createDomainHarness({ adjust: widen });
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const sent = await h.domain.messaging.sendReporting(
      'AR',
      'dev-1',
      { to: ['dev-2'], text: 'Take over the cart work.', taskKey: 'AR-1' },
      { actor: aiActor('dev-1') },
    );
    expect(sent.recipients[0]).toMatchObject({ delivery: 'next_input', noWake: 'no_card_role' });
    const config = await h.domain.projects.config('AR');
    expect(h.domain.messages.wakes(config, sent.message, 'dev-2')).toBe(false);
    await flush();
    expect(sessionsOf('dev-2')).toEqual([]);

    h.domain.tasks.assign('AR', 'AR-1', 'dev-2', OWNER_ACTOR);
    await flush();
    expect(h.domain.messages.wakes(await h.domain.projects.config('AR'), sent.message, 'dev-2')).toBe(true);
    const sessions = sessionsOf('dev-2');
    expect(sessions).toHaveLength(1);
    const specs = h.runner.started.filter((spec) => spec.sessionId === sessions[0]!.id);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.initialMessage).toContain('Take over the cart work.');
    expect(h.repos.messages.pending('AR', 'dev-2')).toHaveLength(0);
  });

  it('an @mention in an AI member’s comment starts a member without a role no more than a message does', async () => {
    h = await createDomainHarness({ adjust: widen });
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    await h.domain.tasks.addNote('AR', 'AR-1', '@dev-2 can you help?', aiActor('dev-1'));
    await flush();
    expect(sessionsOf('dev-2')).toEqual([]);
    expect(h.repos.messages.pending('AR', 'dev-2')).toHaveLength(1);
    await h.domain.tasks.addNote('AR', 'AR-1', '@cr can you review?', aiActor('dev-1'));
    await flush();
    expect(sessionsOf('cr')).toHaveLength(1);
  });
});

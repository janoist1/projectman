import { AiMemberConfig } from '@projectman/shared';
import type { Session, TeamMessage } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiActor, humanActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-421: a new relation on a card that members are working on. The working AI members get a stored
 * `info` message from the system (it starts nothing and waits for an idle session's next input); a
 * prerequisite or a duplicate also asks the card's analyst, with an `action` message, to check it.
 * Cards: AR-1 is worked on by dev-1, AR-2 is another card with a description, AR-3 a third one.
 */
describe('a new relation on a card that is being worked on', () => {
  let h: DomainHarness;
  const task = { type: 'task', taskKey: 'AR-1' } as const;
  const ANALYST = aiActor('analyst');
  const DEV_1 = aiActor('dev-1');
  const DEV_2 = aiActor('dev-2');

  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  /** A project with the three cards; `analysts` are AI members of the business analyst role. */
  async function setup(analysts: string[] = ['analyst']): Promise<void> {
    h = await createDomainHarness({
      adjust: (config) => {
        for (const handle of analysts)
          config.team.members.push(
            AiMemberConfig.parse({
              kind: 'ai',
              handle,
              displayName: handle,
              role: 'business_analyst',
              sponsor: 'owner',
            }),
          );
        config.pipeline.labels.push({
          id: 'analysis-ok',
          name: 'Analysis ok',
          setBy: { duties: ['requirements_analysis'] },
        });
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.tasks.create(
      'AR',
      { title: 'Password reset', description: 'Send a reset link by mail.\nIt expires in an hour.' },
      OWNER_ACTOR,
    );
    await h.domain.tasks.create('AR', { title: 'Sign-up form' }, OWNER_ACTOR);
  }

  const baseline = new Map<string, number>();
  const typedInto = (session: Session) =>
    h.runner.messages
      .filter((m) => m.sessionId === session.id)
      .map((m) => m.text)
      .slice(baseline.get(session.id) ?? 0);

  /** A member works on a card (AR-1) in the development stage, in the given state. */
  async function worker(handle: string, state: 'working' | 'idle', taskKey = 'AR-1'): Promise<Session> {
    const { session } = await h.domain.taskStarts.start('AR', taskKey, {
      assignee: handle,
      actor: OWNER_ACTOR,
      author: OWNER,
    });
    h.runner.setState(session!.id, state);
    await flush();
    baseline.set(session!.id, h.runner.messages.filter((m) => m.sessionId === session!.id).length);
    return session!;
  }

  type Add = { kind: 'part_of' | 'prerequisite' | 'related' | 'duplicate_of'; key: string };
  const relate = async (taskKey: string, add: Add[], actor = OWNER_ACTOR) => {
    await h.domain.tasks.update('AR', taskKey, { relations: { add } }, actor);
    await flush();
  };

  const fromSystem = (): TeamMessage[] => h.repos.messages.list('AR').filter((m) => m.from === 'system');

  describe('the members working on the card', () => {
    it('tells a working member the relation, the other card and its start, without a new session', async () => {
      await setup();
      const dev1 = await worker('dev-1', 'working');
      const started = h.runner.started.length;

      await relate('AR-1', [{ kind: 'related', key: 'AR-2' }]);

      const [message] = fromSystem();
      expect(fromSystem()).toHaveLength(1);
      expect(message).toMatchObject({ from: 'system', to: ['dev-1'], taskKey: 'AR-1', kind: 'info' });
      expect(message!.body.split('\n')[0]).toBe(
        'Relation notice (AR-1): this card is related to AR-2 (added by owner).',
      );
      expect(message!.body).toContain('AR-2');
      expect(message!.body).toContain('Password reset');
      expect(message!.body).toContain('Summary: Send a reset link by mail. It expires in an hour.');
      expect(h.runner.started).toHaveLength(started);

      // It reaches the working member at the end of its turn.
      h.runner.setState(dev1.id, 'idle');
      await flush();
      expect(typedInto(dev1).join('\n')).toContain('Relation notice (AR-1)');
    });

    it('names the relation from the point of view of each card', async () => {
      await setup();
      await worker('dev-1', 'idle');
      await h.domain.taskStarts.start('AR', 'AR-2', {
        assignee: 'dev-2',
        actor: OWNER_ACTOR,
        author: OWNER,
      });
      await flush();

      await relate('AR-1', [
        { kind: 'related', key: 'AR-3' },
        { kind: 'part_of', key: 'AR-2' },
      ]);

      const bodies = new Map(fromSystem().map((m) => [m.to[0]!, m.body]));
      expect(bodies.get('dev-1')).toContain('this card is related to AR-3, is part of AR-2');
      expect(bodies.get('dev-2')).toContain('Relation notice (AR-2): this card has as parts AR-1');
    });

    it('says nothing to the member who added the relation', async () => {
      await setup();
      await worker('dev-1', 'idle');
      const dev2 = await worker('dev-2', 'idle');

      await relate('AR-1', [{ kind: 'related', key: 'AR-2' }], DEV_1);

      expect(fromSystem().map((m) => m.to)).toEqual([['dev-2']]);
      expect(typedInto(dev2)).toEqual([]);
    });

    it('keeps the notice for an idle session until its next input, then marks it delivered', async () => {
      await setup();
      const dev1 = await worker('dev-1', 'idle');

      await relate('AR-1', [{ kind: 'related', key: 'AR-2' }]);

      const [message] = fromSystem();
      expect(typedInto(dev1)).toEqual([]);
      expect(h.runner.started).toHaveLength(1);
      expect(h.repos.messages.get(message!.id)?.receipts?.[0]?.deliveredAt ?? null).toBeNull();

      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Status?', taskKey: 'AR-1' });
      await flush();

      const typed = typedInto(dev1);
      expect(typed).toHaveLength(1);
      expect(typed[0]).toContain('[team message from system about AR-1]\nRelation notice (AR-1)');
      expect(typed[0]!.endsWith('[team message from owner about AR-1]\nStatus?')).toBe(true);
      expect(h.repos.messages.get(message!.id)?.receipts?.[0]?.deliveredAt).toBeTruthy();

      // It is typed once.
      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Again?', taskKey: 'AR-1' });
      await flush();
      expect(typedInto(dev1)[1]).toBe('[team message from owner about AR-1]\nAgain?');
    });

    it('leaves the notice undelivered when the session ends before its next input', async () => {
      await setup();
      const dev1 = await worker('dev-1', 'idle');
      await relate('AR-1', [{ kind: 'related', key: 'AR-2' }]);
      const [message] = fromSystem();

      h.runner.emit({ type: 'transcript_path', sessionId: dev1.id, path: '/fake/transcript.jsonl' });
      h.runner.emit({ type: 'exit', sessionId: dev1.id, exitCode: 0, signal: null });
      await flush();

      expect(typedInto(dev1)).toEqual([]);
      expect(h.repos.messages.get(message!.id)?.receipts?.[0]?.deliveredAt ?? null).toBeNull();
    });

    it('sends one message per member for several relations added by one operation', async () => {
      await setup();
      await worker('dev-1', 'idle');

      await relate('AR-1', [
        { kind: 'related', key: 'AR-2' },
        { kind: 'related', key: 'AR-3' },
      ]);

      expect(fromSystem()).toHaveLength(1);
      const body = fromSystem()[0]!.body;
      expect(body.split('\n')[0]).toBe(
        'Relation notice (AR-1): this card is related to AR-2, is related to AR-3 (added by owner).',
      );
      expect(body).toContain('Password reset');
      expect(body).toContain('Sign-up form');
    });

    it('records who was told and when: a team message on the timeline, a receipt with the time', async () => {
      await setup();
      const dev1 = await worker('dev-1', 'idle');
      await relate('AR-1', [{ kind: 'related', key: 'AR-2' }]);
      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Status?', taskKey: 'AR-1' });
      await flush();

      const event = h.domain.timeline
        .list('AR', { taskKey: 'AR-1' })
        .find((e) => e.type === 'team_message' && e.data.from === 'system');
      expect(event).toBeTruthy();
      expect(event!.data).toMatchObject({ to: ['dev-1'] });
      expect(String(event!.data.excerpt ?? event!.data.text ?? '')).toContain('Relation notice (AR-1)');
      expect(typedInto(dev1)).toHaveLength(1);
    });

    it('says nothing when nobody has a running session, on a removed relation or on a closed card', async () => {
      await setup();
      await relate('AR-1', [{ kind: 'related', key: 'AR-2' }]);
      expect(fromSystem()).toEqual([]);

      const dev1 = await worker('dev-1', 'idle');
      await h.domain.tasks.update(
        'AR',
        'AR-1',
        { relations: { remove: [{ kind: 'related', key: 'AR-2' }] } },
        OWNER_ACTOR,
      );
      await flush();
      expect(fromSystem()).toEqual([]);
      expect(typedInto(dev1)).toEqual([]);
    });

    it('tells the working card of a duplicate, and not the working card that the duplicate closed', async () => {
      await setup();
      await worker('dev-1', 'idle');
      const duplicate = await worker('dev-2', 'idle', 'AR-2');

      // AR-2 is closed as a duplicate of AR-1: AR-1 hears of it, AR-2 (closed by it) does not.
      await relate('AR-2', [{ kind: 'duplicate_of', key: 'AR-1' }]);

      expect(h.domain.tasks.get('AR', 'AR-2').status).toBe('cancelled');
      expect(fromSystem().every((m) => m.taskKey === 'AR-1')).toBe(true);
      expect(
        fromSystem()
          .find((m) => m.to[0] === 'dev-1')!
          .body.split('\n')[0],
      ).toBe('Relation notice (AR-1): this card has as duplicates AR-2 (added by owner).');
      expect(fromSystem().some((m) => m.to.includes('dev-2'))).toBe(false);
      expect(typedInto(duplicate)).toEqual([]);
    });

    it('does not tell a human', async () => {
      await setup();
      await worker('dev-1', 'idle');
      await relate('AR-1', [{ kind: 'related', key: 'AR-2' }]);
      expect(fromSystem().every((m) => m.to.every((handle) => handle !== 'owner'))).toBe(true);
    });
  });

  describe('the analyst check', () => {
    const asked = () => fromSystem().filter((m) => m.kind === 'action');

    it('asks the member who set the analysis label to check a prerequisite, on this very card', async () => {
      await setup(['analyst', 'analyst-2']);
      await h.domain.tasks.update('AR', 'AR-1', { addLabels: ['analysis-ok'] }, aiActor('analyst-2'));
      const dev1 = await worker('dev-1', 'idle');

      await relate('AR-1', [{ kind: 'prerequisite', key: 'AR-2' }]);

      expect(asked()).toHaveLength(1);
      expect(asked()[0]).toMatchObject({ to: ['analyst-2'], taskKey: 'AR-1' });
      expect(asked()[0]!.body.split('\n')[0]).toBe(
        'Analyst check (AR-1): this card needs first (prerequisite) AR-2 (added by owner).',
      );
      expect(asked()[0]!.body).toContain('Do not move or stop the card.');
      // The analyst starts on the card; the worker still gets the plain notice, held for its next input.
      await vi.waitFor(() => expect(h.domain.sessions.findRunning('AR', 'analyst-2', task)).toBeTruthy());
      expect(
        fromSystem()
          .filter((m) => m.kind === 'info')
          .map((m) => m.to),
      ).toEqual([['dev-1']]);
      expect(typedInto(dev1)).toEqual([]);
    });

    it('asks the first analyst of the team when nobody set the label', async () => {
      await setup(['analyst', 'analyst-2']);
      await worker('dev-1', 'idle');

      await relate('AR-3', [{ kind: 'prerequisite', key: 'AR-1' }]);

      expect(asked().map((m) => m.to)).toEqual([['analyst']]);
      expect(asked()[0]!.taskKey).toBe('AR-1');
    });

    it('asks for a duplicate and a prerequisite of the other direction too, and not for a related or a part', async () => {
      await setup();
      await worker('dev-1', 'idle');

      await relate('AR-1', [{ kind: 'related', key: 'AR-2' }]);
      await relate('AR-1', [{ kind: 'part_of', key: 'AR-3' }]);
      expect(asked()).toEqual([]);

      await relate('AR-2', [{ kind: 'prerequisite', key: 'AR-1' }]);
      expect(asked()).toHaveLength(1);
      expect(asked()[0]!.body.split('\n')[0]).toBe(
        'Analyst check (AR-1): this card is the prerequisite of AR-2 (added by owner).',
      );
    });

    it('does not ask the analyst who added the relation', async () => {
      await setup();
      await worker('dev-1', 'idle');

      await relate('AR-1', [{ kind: 'prerequisite', key: 'AR-2' }], ANALYST);

      expect(asked()).toEqual([]);
      expect(fromSystem().map((m) => m.to)).toEqual([['dev-1']]);
    });

    it('sends one merged message to an analyst who also works on the card', async () => {
      await setup();
      await worker('dev-1', 'idle');
      const { session: analyst } = await h.domain.sessions.ensureSession('AR', 'analyst', task);
      h.runner.setState(analyst.id, 'idle');
      await flush();
      baseline.set(analyst.id, h.runner.messages.filter((m) => m.sessionId === analyst.id).length);

      await relate('AR-1', [{ kind: 'prerequisite', key: 'AR-2' }]);

      const toAnalyst = fromSystem().filter((m) => m.to.includes('analyst'));
      expect(toAnalyst).toHaveLength(1);
      expect(toAnalyst[0]!.kind).toBe('action');
      expect(fromSystem().filter((m) => m.to.includes('dev-1'))).toHaveLength(1);
      await flush();
      expect(typedInto(analyst).join('\n')).toContain('Analyst check (AR-1)');
    });

    it('keeps the check for this card even when the analyst has a session on a family card', async () => {
      await setup();
      await h.domain.tasks.create('AR', { title: 'Subtask', parentKey: 'AR-1' }, OWNER_ACTOR);
      await worker('dev-1', 'idle');
      const { session: family } = await h.domain.sessions.ensureSession('AR', 'analyst', {
        type: 'task',
        taskKey: 'AR-4',
      });
      h.runner.setState(family.id, 'idle');
      await flush();
      baseline.set(family.id, h.runner.messages.filter((m) => m.sessionId === family.id).length);
      const waiting: string[] = [];
      h.domain.ctx.events.on(
        'message_waiting',
        (e) => void waiting.push(`${e.handle} ${JSON.stringify(e.workItem)}`),
      );

      await relate('AR-1', [{ kind: 'prerequisite', key: 'AR-2' }]);

      // It waits for the analyst's start on AR-1 and is not typed into the session on the family card.
      expect(asked()[0]).toMatchObject({ to: ['analyst'], taskKey: 'AR-1' });
      expect(waiting).toEqual([`analyst ${JSON.stringify(task)}`]);
      expect(typedInto(family)).toEqual([]);
    });

    it('alerts the owners when there is no analyst to ask', async () => {
      await setup([]);
      await worker('dev-1', 'idle');

      await relate('AR-1', [{ kind: 'prerequisite', key: 'AR-2' }], DEV_2);

      expect(asked()).toEqual([]);
      const alerts = h.domain.inbox.list('AR', { kind: 'alert' });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        assignees: ['owner'],
        taskKey: 'AR-1',
        payload: {
          alert: 'relation_check',
          taskKey: 'AR-1',
          relations: [{ kind: 'prerequisite', key: 'AR-2' }],
        },
      });
      // The worker still gets the plain notice.
      expect(fromSystem().map((m) => m.to)).toEqual([['dev-1']]);
    });

    it('does not alert the owners for a relation that needs no check, or when nobody works on the card', async () => {
      await setup([]);
      await relate('AR-3', [{ kind: 'prerequisite', key: 'AR-2' }]);
      await worker('dev-1', 'idle');
      await relate('AR-1', [{ kind: 'related', key: 'AR-3' }]);
      expect(h.domain.inbox.list('AR', { kind: 'alert' })).toEqual([]);
    });

    it('does not alert the owner who added the relation', async () => {
      await setup([]);
      await worker('dev-1', 'idle');
      await relate('AR-1', [{ kind: 'prerequisite', key: 'AR-2' }], humanActor('owner'));
      expect(h.domain.inbox.list('AR', { kind: 'alert' })).toEqual([]);
    });
  });
});

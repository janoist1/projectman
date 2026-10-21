import { afterEach, describe, expect, it } from 'vitest';
import { questionPayloadOf } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { aiActor } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { settle } from './helpers/fakes';

describe('approval questions', () => {
  let h: DomainHarness;
  let dev: ToolContext;
  afterEach(() => h.cleanup());
  async function setup() {
    h = await createDomainHarness({
      adjust: (config) => {
        config.pipeline.labels.push({ id: 'waiting-answer', name: 'Waiting', setBy: 'anyone', blocks: true });
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    dev = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
  }
  const ask = (question: string) => h.domain.teamTools.askHuman(dev, { question });
  const item = (id: string) => h.domain.inbox.get('AR', id);
  const task = () => h.domain.tasks.get('AR', 'AR-1');

  it.each([
    { options: [{ label: 'Approve', consequence: 'Sets merge-ok' }] },
    { details: 'Please set merge-ok.' },
    { options: ['merge-ok'] },
  ])('recognizes approval references in question context: %j', async (context) => {
    await setup();
    const result = await h.domain.teamTools.askHuman(dev, { question: 'May we proceed?', ...context });
    expect(result.approvalLabel).toBe('merge-ok');
    expect(questionPayloadOf(item(result.inboxItemId))?.approvalLabel).toBe('merge-ok');
  });

  it('makes a question that asks for an approval an owner decision, whatever purpose the asker names', async () => {
    await setup();
    const approval = await h.domain.teamTools.askHuman(dev, {
      question: 'merge-ok?',
      responsePurpose: 'information',
    });
    expect(approval.approvalLabel).toBe('merge-ok');
    expect(questionPayloadOf(item(approval.inboxItemId))?.responsePurpose).toBe('owner_decision');
    const plain = await h.domain.teamTools.askHuman(dev, {
      question: 'Which font?',
      responsePurpose: 'information',
    });
    expect(questionPayloadOf(item(plain.inboxItemId))?.responsePurpose).toBe('information');
  });

  it('closes all matching questions after a manual label change without answering or waking the asker', async () => {
    await setup();
    const first = await ask('merge-ok?');
    const second = await ask('merge-ok again?');
    await settle();
    const messages = [...h.runner.messages];
    const sessions = h.repos.sessions.list('AR');
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['merge-ok'] }, OWNER_ACTOR);
    await settle();
    for (const result of [first, second])
      expect(item(result.inboxItemId)).toMatchObject({
        state: 'resolved',
        resolution: { by: 'system', optionId: 'ended', rule: 'approval_given' },
      });
    expect(task().labels).not.toContain('waiting-answer');
    expect(h.runner.messages).toEqual(messages);
    expect(h.repos.sessions.list('AR')).toEqual(sessions);
  });

  it('leaves unmarked and other approval questions open and retains their waiting label', async () => {
    await setup();
    const matched = await ask('merge-ok?');
    const other = await ask('release-ok?');
    const plain = await ask('Which font?');
    expect(plain).not.toHaveProperty('approvalLabel');
    expect(questionPayloadOf(item(plain.inboxItemId))).not.toHaveProperty('approvalLabel');
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['merge-ok'] }, OWNER_ACTOR);
    await settle();
    expect(item(matched.inboxItemId).state).toBe('resolved');
    expect(item(other.inboxItemId).state).toBe('open');
    expect(item(plain.inboxItemId).state).toBe('open');
    expect(task().labels).toContain('waiting-answer');
  });

  it('closes the question when a gate decision puts the approval label on', async () => {
    await setup();
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['code-review-ok'] }, aiActor('cr'));
    await settle();
    const decision = h.domain.inbox.list('AR', { kind: 'decision', state: 'open', taskKey: 'AR-1' })[0]!;
    const question = await ask('May we proceed?');
    expect(question.approvalLabel).toBe('merge-ok');
    await h.domain.inbox.resolve(
      'AR',
      decision.id,
      { optionId: 'approve' },
      { handle: 'owner', access: 'owner' },
    );
    await settle();
    expect(item(question.inboxItemId)).toMatchObject({
      state: 'resolved',
      resolution: { rule: 'approval_given' },
    });
    expect(task().labels).not.toContain('waiting-answer');
    expect(
      h.runner.messages.filter(
        (message) => message.sessionId === dev.sessionId && message.text.includes('May we proceed?'),
      ),
    ).toEqual([]);
  });
});

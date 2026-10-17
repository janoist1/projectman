import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { questionPayloadOf } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import {
  createDomainHarness,
  restartDomainHarness,
  OWNER,
  OWNER_ACTOR,
  waitForSession,
} from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { settle } from './helpers/fakes';

describe('combined owner questions', () => {
  let h: DomainHarness;
  let dev: ToolContext;
  let dev2: ToolContext;
  let now: Date;
  beforeEach(async () => {
    now = new Date('2026-10-16T08:00:00.000Z');
    h = await createDomainHarness({
      persistent: true,
      screenQuestions: true,
      now: () => now,
      adjust: (config) => {
        const pm = config.team.members.find((m) => m.handle === 'pm')!;
        if (pm.kind === 'ai') pm.onLeave = false;
        config.pipeline.labels.push({
          id: 'waiting-answer',
          name: 'Waiting for an answer',
          setBy: 'anyone',
          blocks: true,
        });
      },
    });
    await h.domain.tasks.create('AR', { title: 'First source' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Second source' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    dev = { sessionId: started.session!.id, member: 'dev-1', projectKey: 'AR', taskKey: 'AR-1' };
    const second = await h.domain.taskStarts.start('AR', 'AR-2', {
      assignee: 'dev-2',
      actor: OWNER_ACTOR,
      author: OWNER,
    });
    dev2 = { sessionId: second.session!.id, member: 'dev-2', projectKey: 'AR', taskKey: 'AR-2' };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.domain.stop();
    await h.cleanup();
  });
  async function ask(taskKey: string, question: string, options = ['Yes', 'No'], as = dev) {
    const result = await h.domain.teamTools.askHuman(as, { taskKey, question, options });
    await settle();
    now = new Date(now.getTime() + 1);
    return result.inboxItemId;
  }
  const pm = async (): Promise<ToolContext> => ({
    projectKey: 'AR',
    member: 'pm',
    taskKey: null,
    sessionId: (await waitForSession(h.domain, { member: 'pm' })).id,
  });
  async function combine(ids: string[]) {
    return h.domain.teamTools.combineQuestions(await pm(), {
      itemIds: ids,
      question: 'May both cards proceed?',
      note: 'Both need the same owner decision.',
    });
  }
  const row = (id: string) => h.domain.inbox.get('AR', id);
  const resolve = (id: string) =>
    h.domain.inbox.resolve(
      'AR',
      id,
      { optionId: 'option_1', note: 'Proceed together' },
      { handle: 'owner', access: 'owner' },
    );
  const withdraw = (id: string, as = dev) =>
    h.domain.teamTools.withdrawQuestion(as, { itemId: id, reason: 'No longer needed' });
  async function pair() {
    const first = await ask('AR-1', 'First?');
    const second = await ask('AR-2', 'Second?', ['Yes', 'No'], dev2);
    const result = await combine([first, second]);
    return [result.primaryItemId, result.linkedItemIds[0]!] as const;
  }

  it('asks once and atomically answers every original question on its own card, even for the same asker', async () => {
    const first = await ask('AR-1', 'May the first proceed?');
    now = new Date(now.getTime() + 60_000);
    const second = await ask('AR-2', 'May the second proceed?');
    const deadline = questionPayloadOf(row(first))!.screening!.until;
    expect(await combine([second, first])).toEqual({ primaryItemId: first, linkedItemIds: [second] });
    expect(row(first).title).toBe('May both cards proceed?');
    expect(questionPayloadOf(row(first))!.group!.originalQuestion).toBe('May the first proceed?');
    expect(questionPayloadOf(row(first))!.screening!.until).toBe(deadline);
    await h.domain.inbox.releaseScreened(first, { outcome: 'decision', by: 'pm', note: 'Owner decides' });
    expect(row(first).state).toBe('open');
    expect(h.repos.inbox.get(second)!.state).toBe('screening');
    expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(1);
    await resolve(first);
    expect(questionPayloadOf(row(first))?.group?.answeredCount).toBe(2);
    for (const id of [first, second])
      expect(row(id)).toMatchObject({
        state: 'resolved',
        resolution: {
          optionId: 'option_1',
          by: 'owner',
          note: 'Proceed together',
        },
      });
    const answers = h.repos.messages.list('AR', {}).filter((m) => m.origin?.kind === 'answer');
    expect(answers).toHaveLength(2);
    expect(answers.map((m) => m.taskKey).sort()).toEqual(['AR-1', 'AR-2']);
    expect(answers.every((m) => m.to.includes('dev-1') && m.from === 'owner')).toBe(true);
    await expect(resolve(first)).rejects.toMatchObject({ code: 'inbox_item_closed' });
    expect(h.repos.messages.list('AR', {}).filter((m) => m.origin?.kind === 'answer')).toHaveLength(2);
  });

  it.each(['primary', 'linked', 'both'] as const)(
    'answers a cardless %s source on its original general route',
    async (cardless) => {
      await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
      const originals: string[] = [];
      for (const [index, as] of [dev, dev2].entries()) {
        if (cardless === 'both' || cardless === (index === 0 ? 'primary' : 'linked')) {
          const { session } = await h.domain.sessions.ensureSession('AR', as.member, { type: 'general' });
          const { inboxItemId } = await h.domain.teamTools.askHuman(
            { ...as, taskKey: null, sessionId: session.id },
            { question: `General question ${index + 1}?`, options: ['Yes', 'No'] },
          );
          originals.push(inboxItemId);
          await settle();
          now = new Date(now.getTime() + 1);
        } else originals.push(await ask(as.taskKey!, `Card question ${index + 1}?`, ['Yes', 'No'], as));
      }
      const { primaryItemId } = await combine(originals);
      const sources = questionPayloadOf(row(primaryItemId))!.group!.sources!;
      expect(sources.every((source) => source.state === 'live')).toBe(true);
      for (const id of originals) {
        const original = h.repos.inbox.get(id)!;
        expect(sources.find((source) => source.itemId === id)?.question).toBe(original.payload.question);
        h.runner.setState(original.sessionId!, 'idle');
      }
      await h.domain.inbox.releaseScreened(primaryItemId, { outcome: 'decision', by: 'pm' });
      await resolve(primaryItemId);
      const answers = h.repos.messages.list('AR', {}).filter((message) => message.origin?.kind === 'answer');
      expect(answers).toHaveLength(2);
      expect(questionPayloadOf(row(primaryItemId))!.group!.answeredCount).toBe(2);
      for (const id of originals) {
        const original = h.repos.inbox.get(id)!;
        const answer = answers.find(
          (message) => message.origin?.kind === 'answer' && message.origin.inboxItemId === id,
        )!;
        expect(original.state).toBe('resolved');
        expect(answer.from).toBe('owner');
        expect(answer.to).toEqual([original.source]);
        expect(answer.taskKey).toBe(original.taskKey);
        expect(
          answer.receipts?.find((receipt) => receipt.handle === original.source)?.route ??
            (answer.taskKey ? { type: 'task', taskKey: answer.taskKey } : { type: 'general' }),
        ).toEqual(original.taskKey ? { type: 'task', taskKey: original.taskKey } : { type: 'general' });
      }
    },
  );

  it('withdraws a cardless primary membership while preserving the shared card answer', async () => {
    await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    const as = { ...dev, taskKey: null, sessionId: session.id };
    const { inboxItemId: first } = await h.domain.teamTools.askHuman(as, {
      question: 'General question?',
      options: ['Yes', 'No'],
    });
    now = new Date(now.getTime() + 1);
    const second = await ask('AR-2', 'Card question?', ['Yes', 'No'], dev2);
    await combine([first, second]);
    await withdraw(first, as);
    expect(questionPayloadOf(row(first))!.group!.sources![0]).toMatchObject({
      taskKey: null,
      question: 'General question?',
      state: 'withdrawn',
    });
    await h.domain.inbox.releaseScreened(first, { outcome: 'decision', by: 'pm' });
    await resolve(first);
    const answers = h.repos.messages.list('AR', {}).filter((message) => message.origin?.kind === 'answer');
    expect(answers.map((message) => message.answer!.inboxItemId)).toEqual([second]);
    expect(questionPayloadOf(row(first))!.group!.answeredCount).toBe(1);
  });

  it('keeps a deleted card distinct from a general source and skips its delivery', async () => {
    const [first, second] = await pair();
    h.repos.db.prepare('DELETE FROM tasks WHERE key = ?').run('AR-2');
    expect(
      questionPayloadOf(row(first))!.group!.sources!.find((source) => source.itemId === second),
    ).toMatchObject({
      taskKey: null,
      taskTitle: null,
      question: null,
      state: 'deleted',
    });
    await h.domain.inbox.releaseScreened(first, { outcome: 'decision', by: 'pm' });
    await resolve(first);
    const answers = h.repos.messages.list('AR', {}).filter((message) => message.origin?.kind === 'answer');
    expect(answers.map((message) => message.answer!.inboxItemId)).toEqual([first]);
  });

  it('rejects incompatible choices without writing a group or changing any question', async () => {
    const first = await ask('AR-1', 'First?');
    const second = await ask('AR-2', 'Second?', ['Different']);
    await expect(combine([first, second])).rejects.toThrow('question_group_incompatible');
    expect(h.repos.inbox.groupOf(first)).toBeNull();
    expect(row(first).title).toBe('First?');
    expect(h.repos.inbox.get(second)!.state).toBe('screening');
  });

  it('refuses a developer, the Operator and a guest PM conversation', async () => {
    const first = await ask('AR-1', 'First?');
    const second = await ask('AR-2', 'Second?');
    const manager = await pm();
    const session = h.repos.sessions.get(manager.sessionId)!;
    h.repos.sessions.insert({
      ...session,
      id: 'ses_guest_pm',
      state: 'exited',
      endedAt: now.toISOString(),
      workItem: { type: 'general', with: 'owner' },
    });
    h.repos.sessions.insert({
      ...session,
      id: 'ses_card_pm',
      state: 'exited',
      endedAt: now.toISOString(),
      workItem: { type: 'task', taskKey: 'AR-1' },
    });
    for (const actor of [
      dev,
      { ...manager, member: 'operator' },
      { ...manager, member: 'owner' },
      { ...manager, sessionId: 'ses_guest_pm' },
      { ...manager, sessionId: 'ses_card_pm' },
    ])
      await expect(
        h.domain.teamTools.combineQuestions(actor, {
          itemIds: [first, second],
          question: 'Both?',
          note: 'Same',
        }),
      ).rejects.toThrow('project_manager_only');
  });

  it('falls back once at the earliest deadline and never opens a linked question', async () => {
    const first = await ask('AR-1', 'First?');
    now = new Date(now.getTime() + 120_000);
    const second = await ask('AR-2', 'Second?');
    await combine([first, second]);
    now = new Date(now.getTime() + 480_001);
    await h.domain.questionScreening.sweep();
    expect(row(first).state).toBe('open');
    expect(h.repos.inbox.get(second)!.state).toBe('screening');
    expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(1);
    expect(await h.domain.inbox.releaseScreened(second, { fallback: 'timeout' })).toBeNull();
  });

  it('keeps the representative after its asker withdraws, releases that card and answers only the remaining asker', async () => {
    const [first, second] = await pair();
    await withdraw(first);
    expect(h.repos.inbox.get(first)).toMatchObject({ state: 'screening', payload: { groupWithdrawn: true } });
    expect(row(first).payload).not.toHaveProperty('groupWithdrawn');
    expect(questionPayloadOf(row(first))?.group?.sources?.[0]?.state).toBe('withdrawn');
    expect(h.domain.tasks.get('AR', 'AR-1').labels).not.toContain('waiting-answer');
    expect(h.domain.tasks.get('AR', 'AR-2').labels).toContain('waiting-answer');
    await expect(withdraw(first)).rejects.toThrow('question_closed');
    await h.domain.inbox.releaseScreened(second, { outcome: 'decision', by: 'pm' });
    await resolve(first);
    const answers = h.repos.messages.list('AR', {}).filter((m) => m.origin?.kind === 'answer');
    expect(questionPayloadOf(row(first))?.group?.answeredCount).toBe(1);
    expect(questionPayloadOf(row(second))?.group).not.toHaveProperty('answeredCount');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ to: ['dev-2'], answer: { inboxItemId: second }, taskKey: 'AR-2' });
    expect(h.domain.tasks.get('AR', 'AR-2').labels).not.toContain('waiting-answer');
  });

  it('keeps waiting-answer while another original question on the same card is live', async () => {
    const first = await ask('AR-1', 'First?');
    const second = await ask('AR-1', 'Second?');
    const combined = await combine([first, second]);
    await withdraw(combined.primaryItemId);
    expect(h.domain.tasks.get('AR', 'AR-1').labels).toContain('waiting-answer');
    await withdraw(combined.linkedItemIds[0]!);
    expect(row(combined.primaryItemId)).toMatchObject({
      state: 'cancelled',
      resolution: { rule: 'group_withdrawn' },
    });
    expect(h.domain.tasks.get('AR', 'AR-1').labels).not.toContain('waiting-answer');
  });

  it('keeps an unrelated pending question and cancels the group only when its final member leaves', async () => {
    const [first, second] = await pair();
    await ask('AR-1', 'An unrelated decision?', ['Other']);
    await withdraw(second, dev2);
    expect(row(first).state).toBe('screening');
    await withdraw(first);
    expect(row(first)).toMatchObject({ state: 'cancelled', resolution: { rule: 'group_withdrawn' } });
    expect(h.domain.tasks.get('AR', 'AR-1').labels).toContain('waiting-answer');
    expect(h.domain.tasks.get('AR', 'AR-2').labels).not.toContain('waiting-answer');
  });

  it('closes only the selected membership for moot and refuses the other AI outcomes without writes', async () => {
    const [first, second] = await pair();
    const before = h.repos.inbox.get(first);
    for (const args of [
      { outcome: 'answered' as const, answer: 'Yes' },
      { outcome: 'forwarded' as const, forwardTo: 'cr' },
      { outcome: 'todo' as const, todo: { what: 'Check', where: 'Here', expected: 'Done' } },
    ])
      await expect(
        h.domain.teamTools.screenQuestion(await pm(), { itemId: first, note: 'Reason', ...args }),
      ).rejects.toThrow('question_group_incompatible');
    expect(h.repos.inbox.get(first)).toEqual(before);
    expect(h.repos.messages.list('AR', {})).toHaveLength(0);
    await h.domain.teamTools.screenQuestion(await pm(), {
      itemId: first,
      outcome: 'moot',
      note: 'First is moot',
    });
    expect(questionPayloadOf(row(first))?.group?.sources?.find((s) => s.itemId === first)?.state).toBe(
      'withdrawn',
    );
    expect(h.repos.inbox.get(second)!.state).toBe('screening');
  });

  it('allows moot for an opened group linked member while preserving the other answer', async () => {
    const [first, second] = await pair();
    await h.domain.inbox.releaseScreened(first, { outcome: 'decision', by: 'pm' });
    await h.domain.teamTools.screenQuestion(await pm(), {
      itemId: second,
      outcome: 'moot',
      note: 'No longer needed',
    });
    expect(row(second)).toMatchObject({ state: 'cancelled', resolution: { rule: 'operator_moot' } });
    expect(row(first).state).toBe('open');
    await expect(
      h.domain.teamTools.screenQuestion(await pm(), {
        itemId: second,
        outcome: 'moot',
        note: 'Already closed',
      }),
    ).rejects.toThrow('question_not_screening');
    await resolve(first);
    const answers = h.repos.messages.list('AR', {}).filter((message) => message.origin?.kind === 'answer');
    expect(answers.map((message) => message.answer!.inboxItemId)).toEqual([first]);
  });

  it('serializes a withdrawal against the owner answer and fallback without duplicating a recipient', async () => {
    const [first, second] = await pair();
    await h.domain.inbox.releaseScreened(first, { outcome: 'decision', by: 'pm' });
    await Promise.all([
      resolve(first),
      withdraw(second, dev2).catch(() => undefined),
      h.domain.inbox.releaseScreened(first, { fallback: 'timeout' }),
    ]);
    const answers = h.repos.messages.list('AR', {}).filter((m) => m.origin?.kind === 'answer');
    expect(new Set(answers.map((m) => m.answer!.inboxItemId)).size).toBe(answers.length);
    expect(row(first).state).toBe('resolved');
    expect(row(second).state).toBe('resolved');
  });

  it('excludes a withdrawal that acquired the group lock before the answer', async () => {
    const [first, second] = await pair();
    await h.domain.inbox.releaseScreened(first, { outcome: 'decision', by: 'pm' });
    await Promise.all([
      h.domain.inbox.closeQuestion(second, { rule: 'withdrawn', by: 'dev-2', note: 'No longer needed' }),
      resolve(first),
    ]);
    const answers = h.repos.messages.list('AR', {}).filter((m) => m.origin?.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]?.to).toEqual(['dev-1']);
    expect(row(second).state).toBe('cancelled');
  });

  it('restores the durable group after restart and releases only its representative on timeout', async () => {
    const [first, second] = await pair();
    now = new Date(now.getTime() + 600_001);
    h = await restartDomainHarness(h, { screenQuestions: true, now: () => now });
    await h.domain.questionScreening.sweep();
    expect(row(first).state).toBe('open');
    expect(h.repos.inbox.get(second)!.state).toBe('screening');
    expect(questionPayloadOf(row(first))?.group?.itemIds).toEqual([first, second]);
  });

  it('keeps the historical answer count when a source card is deleted later', async () => {
    const [first] = await pair();
    await h.domain.inbox.releaseScreened(first, { outcome: 'decision', by: 'pm' });
    await resolve(first);
    expect(questionPayloadOf(row(first))?.group?.answeredCount).toBe(2);
    h.repos.db.prepare('DELETE FROM tasks WHERE key = ?').run('AR-2');
    expect(questionPayloadOf(row(first))?.group?.sources?.some((source) => source.state === 'deleted')).toBe(
      true,
    );
    expect(questionPayloadOf(row(first))?.group?.answeredCount).toBe(2);
  });

  it('shares one answer file through each recipient’s own visible message and deletes every reference', async () => {
    const [first, second] = await pair();
    await h.domain.inbox.releaseScreened(first, { outcome: 'decision', by: 'pm' });
    const file = await h.domain.messageAttachments.upload({
      projectKey: 'AR',
      actor: OWNER_ACTOR,
      fileName: 'answer.txt',
      content: Readable.from(['Approved for both cards']),
    });
    await h.domain.inbox.resolve(
      'AR',
      first,
      { optionId: 'answer', attachmentIds: [file.id] },
      { handle: 'owner', access: 'owner' },
    );
    const answers = h.repos.messages.listByAttachment('AR', file.id);
    expect(answers).toHaveLength(2);
    const own = answers.find((m) => m.to.includes('dev-2'))!;
    const anchor = h.repos.messageAttachments.get(file.id)!.messageId;
    expect(own.id).not.toBe(anchor);
    const reading = await h.domain.messageAttachments.reading('AR', file.id, {
      handle: 'dev-2',
      access: 'ai',
    });
    expect(reading.message.id).toBe(own.id);
    const opened = await h.domain.messageAttachments.open('AR', file.id, { kind: 'ai', handle: 'dev-2' });
    expect(opened.attachment.messageId).toBe(own.id);
    opened.stream.destroy();
    await expect(
      h.domain.messageAttachments.reading('AR', file.id, { handle: 'cr', access: 'ai' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      h.domain.messageAttachments.reading('OTHER', file.id, { handle: 'dev-2', access: 'ai' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      h.domain.messaging.send('AR', 'owner', { to: ['dev-2'], text: 'Reuse', attachmentIds: [file.id] }),
    ).rejects.toMatchObject({ code: 'message_attachment_unavailable' });
    await h.domain.messageAttachments.delete('AR', file.id, OWNER_ACTOR);
    expect(h.repos.messages.listByAttachment('AR', file.id).every((m) => !!m.attachments?.[0]?.goneAt)).toBe(
      true,
    );
    await expect(
      h.domain.messageAttachments.reading('AR', file.id, { handle: 'dev-2', access: 'ai' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(row(second).resolution?.by).toBe('owner');
  });

  it('rolls back every row, file binding and timeline on a mid-fanout failure, then retries once', async () => {
    const [first, second] = await pair();
    await h.domain.inbox.releaseScreened(first, { outcome: 'decision', by: 'pm' });
    const file = await h.domain.messageAttachments.upload({
      projectKey: 'AR',
      actor: OWNER_ACTOR,
      fileName: 'answer.txt',
      content: Readable.from(['Approved']),
    });
    const insert = h.repos.messages.insert.bind(h.repos.messages);
    let count = 0;
    const spy = vi.spyOn(h.repos.messages, 'insert').mockImplementation((message) => {
      if (++count === 2) throw new Error('second fanout failed');
      insert(message);
    });
    const answer = () =>
      h.domain.inbox.resolve(
        'AR',
        first,
        { optionId: 'option_1', attachmentIds: [file.id] },
        { handle: 'owner', access: 'owner' },
      );
    await expect(answer()).rejects.toThrow('second fanout failed');
    spy.mockRestore();
    expect(h.repos.inbox.get(first)!.state).toBe('open');
    expect(h.repos.inbox.get(second)!.state).toBe('screening');
    expect(h.repos.messages.listByAttachment('AR', file.id)).toHaveLength(0);
    expect(h.repos.messageAttachments.get(file.id)!.messageId).toBeUndefined();
    expect(h.repos.timeline.listOfTypes('AR', 'AR-1', ['question_answered'], 20)).toHaveLength(0);
    await answer();
    expect(h.repos.messages.listByAttachment('AR', file.id)).toHaveLength(2);
  });
});

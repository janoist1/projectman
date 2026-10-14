import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '../src/kernel';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { pngBytes } from './helpers/attachments';
import { flush } from './helpers/fakes';

describe('attachments in answers to inbox questions', () => {
  let h: DomainHarness;
  let sessionId: string;
  beforeEach(async () => {
    h = await createDomainHarness({ sessionFolders: true });
    await h.domain.tasks.create('AR', { title: 'Layout' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', {
      type: 'task',
      taskKey: 'AR-1',
    });
    sessionId = session.id;
    h.runner.setState(session.id, 'idle');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.cleanup();
  });
  const ask = () =>
    h.domain.teamTools.askHuman(
      {
        projectKey: 'AR',
        member: 'dev-1',
        taskKey: 'AR-1',
        sessionId,
      },
      { question: 'Which layout?', options: ['First', 'Second'] },
    );
  const put = () =>
    h.domain.messageAttachments.upload({
      projectKey: 'AR',
      actor: OWNER_ACTOR,
      fileName: 'screen.png',
      content: Readable.from([pngBytes()]),
    });
  const answer = (id: string, attachmentIds: string[], optionId = 'answer') =>
    h.domain.inbox.resolve('AR', id, { optionId, attachmentIds }, { handle: 'owner', access: 'owner' });
  const messages = () => h.repos.messages.list('AR', { participant: 'owner' });

  it('sends a file-only answer to the asking session and lets the asker read it', async () => {
    const question = await ask();
    const file = await put();
    const resolved = await answer(question.inboxItemId, [file.id]);
    expect(resolved.state).toBe('resolved');
    const message = messages().find((entry) => entry.answer?.inboxItemId === question.inboxItemId)!;
    expect(message.attachments).toEqual([expect.objectContaining({ id: file.id })]);
    await flush();
    const delivered = h.runner.messages.find(
      (entry) => entry.sessionId === sessionId && entry.text.includes(file.id),
    );
    expect(delivered?.text).toContain('Attachments');
    expect(delivered?.text).toContain('read_message_attachment');
    const opened = await h.domain.teamTools.readMessageAttachment(
      {
        projectKey: 'AR',
        member: 'dev-1',
        taskKey: 'AR-1',
        sessionId,
      },
      { attachmentId: file.id },
    );
    expect(opened).toMatchObject({ attachment: expect.objectContaining({ id: file.id }) });
  });

  it('includes the files with an option answer and records only one answer message', async () => {
    const question = await ask();
    const file = await put();
    await answer(question.inboxItemId, [file.id], 'option_1');
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({ answer: { answer: 'First' }, attachments: [{ id: file.id }] });
  });

  it('refuses attachments on another inbox kind, including an empty array', async () => {
    const item = h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'alert',
      source: 'system',
      assignees: ['owner'],
      title: 'Alert',
      payload: {},
      options: [{ id: 'dismiss', label: 'dismiss', style: 'secondary' }],
    });
    await expect(answer(item.id, [], 'dismiss')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
      details: { field: 'attachmentIds' },
    });
    expect(h.domain.inbox.get('AR', item.id).state).toBe('open');
  });

  it('refuses another uploader, unknown and already sent files without closing the question', async () => {
    const question = await ask();
    const other = await h.domain.messageAttachments.upload({
      projectKey: 'AR',
      actor: { kind: 'ai', handle: 'dev-1' },
      fileName: 'other.png',
      content: Readable.from([pngBytes()]),
    });
    for (const id of [other.id, 'msa_unknown000000']) {
      await expect(answer(question.inboxItemId, [id])).rejects.toMatchObject({
        status: 409,
        code: 'message_attachment_unavailable',
      });
      expect(h.domain.inbox.get('AR', question.inboxItemId).state).toBe('open');
      expect(messages()).toHaveLength(0);
    }
    const used = await put();
    await h.domain.messaging.send('AR', 'owner', {
      to: ['dev-1'],
      text: 'Already sent',
      attachmentIds: [used.id],
    });
    await expect(answer(question.inboxItemId, [used.id])).rejects.toMatchObject({
      status: 409,
      code: 'message_attachment_unavailable',
    });
    expect(h.domain.inbox.get('AR', question.inboxItemId).state).toBe('open');
    expect(messages()).toHaveLength(1);
  });

  it('rolls back closure, timeline and binding when message recording fails, and can retry', async () => {
    const question = await ask();
    const file = await put();
    const events: string[] = [];
    h.domain.bus.subscribe((event) => events.push(event.type));
    const recording = vi.spyOn(h.repos.messages, 'insert').mockImplementationOnce(() => {
      throw new Error('record failed');
    });
    await expect(answer(question.inboxItemId, [file.id])).rejects.toThrow('record failed');
    expect(h.domain.inbox.get('AR', question.inboxItemId).state).toBe('open');
    expect(messages()).toHaveLength(0);
    expect(events).not.toContain('inbox_upserted');
    expect(h.repos.timeline.listOfTypes('AR', 'AR-1', ['question_answered'], 20)).toHaveLength(0);
    recording.mockRestore();
    await answer(question.inboxItemId, [file.id]);
    expect(messages()).toHaveLength(1);
  });

  it('keeps empty text answers invalid and refuses a second resolution of the same question', async () => {
    const question = await ask();
    await expect(answer(question.inboxItemId, [])).rejects.toMatchObject({ code: 'answer_required' });
    const file = await put();
    const results = await Promise.allSettled([
      answer(question.inboxItemId, [file.id]),
      answer(question.inboxItemId, [file.id]),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(DomainError);
    expect(failure.reason.code).toBe('inbox_item_closed');
    expect(messages()).toHaveLength(1);
  });
});

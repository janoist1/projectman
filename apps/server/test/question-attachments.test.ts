import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { questionAttachmentsOf, questionPayloadOf } from '@projectman/shared';
import type { Attachment, ServerEvent } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { pdfBytes, pngBytes } from './helpers/attachments';
import { createDomainHarness, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';

const WAITING = 'waiting-answer';

/**
 * The files an ask_human question names (PM-498): what the tool accepts and stores, what it
 * refuses, and how a deleted file is marked on the questions that name it.
 */
describe('files on an ask_human question', () => {
  let h: DomainHarness;
  /** dev-1 working on AR-2, a subtask of AR-1. */
  let dev: ToolContext;

  beforeEach(async () => {
    h = await createDomainHarness({
      persistent: true,
      adjust: (config) => {
        config.pipeline.labels.push({ id: WAITING, name: 'Waiting', setBy: 'anyone', blocks: true });
        config.team.members.push({
          kind: 'human',
          handle: 'cleo',
          displayName: 'Cleo',
          access: 'client',
          roles: [],
        });
      },
    });
    await setUpCards(h);
  });
  afterEach(() => h.cleanup());

  async function setUpCards(harness: DomainHarness): Promise<void> {
    await harness.domain.tasks.create('AR', { title: 'Parent' }, OWNER_ACTOR);
    await harness.domain.tasks.create('AR', { title: 'Child', parentKey: 'AR-1' }, OWNER_ACTOR);
    await harness.domain.tasks.create('AR', { title: 'Unrelated' }, OWNER_ACTOR);
    const started = await harness.domain.taskStarts.start('AR', 'AR-2', {
      actor: OWNER_ACTOR,
      author: { name: 'Owner', email: 'owner@example.com' },
    });
    dev = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-2' };
  }

  const upload = (
    taskKey: string,
    fileName: string,
    content: Buffer = pngBytes(120),
    harness: DomainHarness = h,
  ): Promise<Attachment> =>
    harness.domain.attachments.upload({
      projectKey: 'AR',
      taskKey,
      actor: OWNER_ACTOR,
      fileName,
      content: Readable.from([content]),
    });
  const ask = (attachmentIds?: string[], extra: { taskKey?: string; to?: string[] } = {}) =>
    h.domain.teamTools.askHuman(dev, {
      question: 'Which of these?',
      ...(attachmentIds ? { attachmentIds } : {}),
      ...extra,
    });
  const refusal = async (promise: Promise<unknown>) => {
    const err = await rejection(promise, TeamToolError);
    return { code: err.code, message: err.message };
  };
  const nothingLeft = () => {
    expect(h.domain.inbox.list('AR', { kind: 'question' })).toEqual([]);
    expect(h.domain.tasks.get('AR', 'AR-2').labels).not.toContain(WAITING);
  };

  describe('asking', () => {
    it('stores a snapshot of a file of the card and of its parent, in order, without repeats', async () => {
      const shot = await upload('AR-2', 'shot.png');
      const spec = await upload('AR-1', 'spec.pdf', pdfBytes());

      const asked = await ask([spec.id, shot.id, spec.id]);

      const expected = [
        {
          id: spec.id,
          taskKey: 'AR-1',
          fileName: 'spec.pdf',
          size: spec.size,
          mediaType: 'application/pdf',
          preview: 'pdf',
        },
        {
          id: shot.id,
          taskKey: 'AR-2',
          fileName: 'shot.png',
          size: 120,
          mediaType: 'image/png',
          preview: 'image',
        },
      ];
      expect(asked.attachments).toEqual(expected);
      const item = h.domain.inbox.get('AR', asked.inboxItemId);
      expect(questionAttachmentsOf(item)).toEqual(expected);
      expect(questionPayloadOf(item)?.attachments).toEqual(expected);
    });

    it('leaves the field out when no file is named', async () => {
      const asked = await ask();
      expect(asked).not.toHaveProperty('attachments');
      const item = h.domain.inbox.get('AR', asked.inboxItemId);
      expect(item.payload).not.toHaveProperty('attachments');
      expect(questionAttachmentsOf(item)).toEqual([]);
    });
  });

  describe('refusals', () => {
    it('refuses files on a question that is not about a card', async () => {
      const shot = await upload('AR-2', 'shot.png');
      const general: ToolContext = { ...dev, taskKey: null };
      const error = await refusal(
        h.domain.teamTools.askHuman(general, { question: 'Which?', attachmentIds: [shot.id] }),
      );
      expect(error).toEqual({
        code: 'invalid',
        message:
          'attachments_need_card: files can be named only on a question about a card; give task_key or ask without attachments.',
      });
      expect(h.domain.inbox.list('AR', { kind: 'question' })).toEqual([]);
    });

    it('refuses an unknown id', async () => {
      const error = await refusal(ask(['att_unknown00001']));
      expect(error).toEqual({
        code: 'not_found',
        message:
          'attachment_unknown: att_unknown00001 is not a file of AR-2 or its parent AR-1; list_attachments gives the ids.',
      });
      nothingLeft();
    });

    it('answers a file of another project like an unknown one, and shortens the text on a card without parent', async () => {
      const shot = await upload('AR-2', 'shot.png');
      const workspace = join(h.dir, 'beta');
      mkdirSync(workspace);
      await h.domain.projects.create(
        { key: 'BX', name: 'beta', workspacePath: workspace, templateId: 'test' },
        { name: 'Owner', email: 'owner@example.com' },
      );
      await h.domain.tasks.create('BX', { title: 'Beta task' }, OWNER_ACTOR);
      const foreignFile = await h.domain.attachments.upload({
        projectKey: 'BX',
        taskKey: 'BX-1',
        actor: OWNER_ACTOR,
        fileName: 'secret.png',
        content: Readable.from([pngBytes(50)]),
      });

      const foreign = await refusal(ask([foreignFile.id]));
      const unknown = await refusal(ask(['att_unknown00001']));
      expect(foreign.code).toBe('not_found');
      expect(foreign.message).toBe(unknown.message.replace('att_unknown00001', foreignFile.id));
      nothingLeft();

      // A card without a parent gets the shorter text.
      const alone = { ...dev, taskKey: 'AR-3' };
      const noParent = await refusal(
        h.domain.teamTools.askHuman(alone, { question: 'Which?', attachmentIds: ['att_unknown00001'] }),
      );
      expect(noParent.message).toBe(
        'attachment_unknown: att_unknown00001 is not a file of AR-3; list_attachments gives the ids.',
      );
      expect(shot.taskKey).toBe('AR-2');
    });

    it('refuses a file of another card of the project, naming the card', async () => {
      const other = await upload('AR-3', 'other.png');
      const error = await refusal(ask([other.id]));
      expect(error).toEqual({
        code: 'invalid',
        message: `attachment_other_card: ${other.id} is on AR-3; a question can name only the files of AR-2 or its parent AR-1.`,
      });
      nothingLeft();
    });

    it('refuses a file that is being written or deleted, like an unknown one', async () => {
      const shot = await upload('AR-2', 'shot.png');
      h.repos.attachments.markDeleting(shot.id, OWNER_ACTOR, new Date().toISOString());
      h.repos.attachments.insertPending({
        id: 'att_pendingfile01',
        projectKey: 'AR',
        taskKey: 'AR-2',
        fileName: 'half.png',
        uploadedBy: OWNER_ACTOR,
        createdAt: new Date().toISOString(),
      } as never);
      for (const id of [shot.id, 'att_pendingfile01']) {
        expect(await refusal(ask([id]))).toMatchObject({ code: 'not_found' });
      }
      nothingLeft();
    });

    it('refuses to ask a client about the files of an internal card', async () => {
      const shot = await upload('AR-2', 'shot.png');
      const error = await refusal(ask([shot.id], { to: ['cleo'] }));
      expect(error).toEqual({
        code: 'invalid',
        message:
          'attachment_not_visible: cleo cannot open the files of AR-2; ask without them or ask someone who sees the card.',
      });
      nothingLeft();
    });

    it('lets a client be asked about the files of a shared card', async () => {
      await h.domain.tasks.update('AR', 'AR-2', { visibility: 'shared' }, OWNER_ACTOR);
      const shot = await upload('AR-2', 'shot.png');
      const asked = await ask([shot.id], { to: ['cleo'] });
      expect(asked.attachments).toHaveLength(1);
    });
  });

  describe('deleting a named file', () => {
    const record = (harness: DomainHarness): ServerEvent[] => {
      const events: ServerEvent[] = [];
      harness.domain.bus.subscribe((event) => events.push(event));
      return events;
    };
    const upserted = (events: ServerEvent[]) =>
      events.flatMap((event) => (event.type === 'inbox_upserted' ? [event.item.id] : []));

    it('marks the file gone on an open and an answered question, and publishes both, not the others', async () => {
      const shot = await upload('AR-2', 'shot.png');
      const spec = await upload('AR-1', 'spec.pdf', pdfBytes());
      const answered = await ask([shot.id, spec.id]);
      await h.domain.inbox.resolve(
        'AR',
        answered.inboxItemId,
        { optionId: 'answer', note: 'The first.' },
        { handle: 'owner', access: 'owner' },
      );
      expect(h.domain.inbox.get('AR', answered.inboxItemId).state).toBe('resolved');
      const open = await ask([shot.id]);
      const other = await ask([spec.id]);
      const plain = await ask();
      const events = record(h);

      await h.domain.attachments.delete('AR', 'AR-2', shot.id, OWNER_ACTOR);

      const gone = (id: string) => questionAttachmentsOf(h.domain.inbox.get('AR', id)).map((a) => a.goneAt);
      expect(gone(open.inboxItemId)).toEqual([expect.any(String)]);
      expect(gone(answered.inboxItemId)).toEqual([expect.any(String), undefined]);
      expect(gone(other.inboxItemId)).toEqual([undefined]);
      expect(gone(plain.inboxItemId)).toEqual([]);
      expect(upserted(events).sort()).toEqual([answered.inboxItemId, open.inboxItemId].sort());
    });

    it('marks the file when a deletion is finished by the recovery after a restart', async () => {
      const shot = await upload('AR-2', 'shot.png');
      const asked = await ask([shot.id]);
      h.repos.attachments.markDeleting(shot.id, OWNER_ACTOR, new Date().toISOString());

      const next = await restartDomainHarness(h, { persistent: true });
      h = next;

      expect(h.repos.attachments.get(shot.id)).toBeNull();
      expect(questionAttachmentsOf(h.domain.inbox.get('AR', asked.inboxItemId))).toMatchObject([
        { id: shot.id, goneAt: expect.any(String) },
      ]);
    });
  });
});

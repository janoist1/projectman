import { mkdirSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { pdfBytes, pngBytes } from './helpers/attachments';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { settle } from './helpers/fakes';

const toolError = (promise: Promise<unknown>) => rejection(promise, TeamToolError);

/** `send_message` with `attachments` (PM-520): an AI member sends files of its folders with a message. */
describe('send_message with attachments (PM-520)', () => {
  let h: DomainHarness;
  let dev: ToolContext;
  let cwd: string;
  let folder: string;

  beforeEach(async () => {
    h = await createDomainHarness({ sessionFolders: true });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    dev = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
    cwd = started.session!.cwd;
    folder = h.runner.lastStarted().sandbox!.env!.PROJECTMAN_SESSION_DIR!;
    writeFileSync(join(folder, 'screen.png'), pngBytes(300));
    writeFileSync(join(cwd, 'notes.txt'), 'some notes');
  });
  afterEach(() => h.cleanup());

  const send = (attachments: string[] | undefined, to = ['owner']) =>
    h.domain.teamTools.sendMessage(dev, {
      to,
      text: 'See the file',
      kind: 'info',
      ...(attachments ? { attachments } : {}),
    });
  const files = (): string[] => {
    try {
      return readdirSync(join(h.messageAttachmentsDir, 'AR'));
    } catch {
      return [];
    }
  };
  const sent = (messageId: string) => h.repos.messages.get(messageId)!;

  it('sends one file of the session folder to a person, who sees it with the message', async () => {
    const result = await send([join(folder, 'screen.png')]);
    expect(sent(result.messageId).attachments).toEqual([
      expect.objectContaining({
        fileName: 'screen.png',
        size: 300,
        mediaType: 'image/png',
        preview: 'image',
      }),
    ]);
    const [entry] = sent(result.messageId).attachments!;
    const opened = await h.domain.messageAttachments.open('AR', entry!.id, OWNER_ACTOR);
    expect(opened.attachment).toMatchObject({
      messageId: result.messageId,
      uploadedBy: { kind: 'ai', handle: 'dev-1' },
    });
    opened.stream.destroy();
  });

  it('sends several files, from the folder and from the working directory, in the given order', async () => {
    const result = await send([join(folder, 'screen.png'), 'notes.txt']);
    expect(sent(result.messageId).attachments?.map((a) => a.fileName)).toEqual(['screen.png', 'notes.txt']);
  });

  it('delivers the files to an AI recipient with the message text', async () => {
    const result = await send(['notes.txt'], ['dev-2']);
    await settle();
    expect(result.deliveredTo).toEqual(['dev-2']);
    expect(sent(result.messageId).attachments).toHaveLength(1);
  });

  it('sends a message without files as before', async () => {
    const result = await send(undefined);
    expect(sent(result.messageId).attachments).toBeUndefined();
    expect(files()).toEqual([]);
  });

  it('sends nothing and stores nothing when one file is outside both places, naming it', async () => {
    const elsewhere = join(h.dir, 'elsewhere.txt');
    writeFileSync(elsewhere, 'not for the message');
    const err = await toolError(send([join(folder, 'screen.png'), 'notes.txt', elsewhere]));
    expect(err.code).toBe('forbidden');
    expect(err.message).toContain(elsewhere);
    expect(err.message).toContain('Nothing was sent');
    expect(files()).toEqual([]);
    expect(h.repos.messages.list('AR', { participant: 'owner' })).toEqual([]);
  });

  it('sends nothing when a file is missing, a directory or a link, naming it', async () => {
    mkdirSync(join(cwd, 'dir'));
    symlinkSync(join(cwd, 'notes.txt'), join(cwd, 'soft.txt'));
    for (const path of ['missing.png', 'dir', 'soft.txt']) {
      const err = await toolError(send(['notes.txt', path]));
      expect(err.code, path).toBe('invalid');
      expect(err.message, path).toContain(path);
      expect(files(), path).toEqual([]);
    }
  });

  it('sends nothing when a file is over the size limit, and leaves no orphan upload', async () => {
    const big = join(cwd, 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, MAX_ATTACHMENT_BYTES + 1);
    const err = await toolError(send(['notes.txt', 'big.bin']));
    expect(err.code).toBe('invalid');
    expect(err.message).toContain('big.bin');
    expect(files()).toEqual([]);
  });

  it('refuses an action message to a person before any file is read', async () => {
    const err = await toolError(
      h.domain.teamTools.sendMessage(dev, {
        to: ['owner'],
        text: 'Do this',
        kind: 'action',
        attachments: ['notes.txt'],
      }),
    );
    expect(err.message).toMatch(/^use_ask_human:/);
    expect(files()).toEqual([]);
  });

  it('removes the stored files when the send itself is refused (an unknown recipient)', async () => {
    await toolError(send(['notes.txt', join(folder, 'screen.png')], ['nobody-here']));
    expect(files()).toEqual([]);
  });

  it('keeps the file type check of the storage (a PDF stays a PDF)', async () => {
    writeFileSync(join(folder, 'doc.pdf'), pdfBytes());
    const result = await send([join(folder, 'doc.pdf')]);
    expect(sent(result.messageId).attachments?.[0]).toMatchObject({
      fileName: 'doc.pdf',
      mediaType: 'application/pdf',
    });
  });
});

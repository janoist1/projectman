import { randomBytes } from 'node:crypto';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTACHMENT_BYTES, MAX_UNSENT_MESSAGE_ATTACHMENTS } from '@projectman/shared';
import type { Actor, ServerEvent } from '@projectman/shared';
import { MESSAGE_IMAGE_MAX_BYTES, TeamToolError } from '../../../contracts';
import type { ToolContext } from '../../../contracts';
import { aiActor } from '../../../domain';
import { MessageImageRenderer } from '../message-attachments/image';
import { pdfBytes, pngBytes } from '../../../../test/helpers/attachments';
import {
  createDomainHarness,
  OWNER,
  OWNER_ACTOR,
  restartDomainHarness,
} from '../../../../test/helpers/domain-harness';
import type { DomainHarness } from '../../../../test/helpers/domain-harness';
import { rejection } from '../../../../test/helpers/errors';
import { flush } from '../../../../test/helpers/fakes';

const dev1 = aiActor('dev-1');
const aiViewer = (handle: string) => ({ access: 'ai' as const, handle });

/** A real image of the given size (PNG), the colour a flat fill. */
const realPng = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: '#3366ff' } })
    .png()
    .toBuffer();

/** The files of team messages: upload, send, see, read and delete, over the real domain and storage. */
describe('message attachments', () => {
  let h: DomainHarness;
  let clock: Date;
  const open: DomainHarness[] = [];

  beforeEach(async () => {
    clock = new Date('2026-10-11T08:00:00.000Z');
    // Persistent: the recovery test starts the domain again over the same files.
    h = await createDomainHarness({ now: () => clock, persistent: true });
    open.push(h);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const harness of open.splice(0).reverse()) {
      await harness.domain.stop();
      await harness.cleanup();
    }
  });

  const put = (
    content: Buffer | Readable = pngBytes(),
    opts: { actor?: Actor; fileName?: string; harness?: DomainHarness } = {},
  ) =>
    (opts.harness ?? h).domain.messageAttachments.upload({
      projectKey: 'AR',
      actor: opts.actor ?? OWNER_ACTOR,
      fileName: opts.fileName ?? 'shot.png',
      content: Buffer.isBuffer(content) ? Readable.from([content]) : content,
    });
  const send = (
    attachmentIds: string[],
    opts: { from?: string; to?: string[]; text?: string; taskKey?: string | null } = {},
  ) => {
    const from = opts.from ?? 'owner';
    return h.domain.messaging.send(
      'AR',
      from,
      {
        to: opts.to ?? ['dev-1'],
        text: opts.text ?? 'Look at this.',
        taskKey: opts.taskKey ?? null,
        attachmentIds,
      },
      // An AI member's message is sent in its own name, as the team tool does.
      { actor: from === 'owner' ? OWNER_ACTOR : aiActor(from) },
    );
  };
  const events = (): ServerEvent[] => {
    const seen: ServerEvent[] = [];
    h.domain.bus.subscribe((event) => seen.push(event));
    return seen;
  };
  const filesOf = (harness = h): string[] => {
    try {
      return readdirSync(join(harness.messageAttachmentsDir, 'AR')).sort();
    } catch {
      return [];
    }
  };

  describe('uploading', () => {
    it('stores the file under the generated id, ready and unsent', async () => {
      const stored = await put(pngBytes(300), { fileName: '../../Kép ernyő.png' });
      expect(stored).toMatchObject({
        projectKey: 'AR',
        size: 300,
        mediaType: 'image/png',
        preview: 'image',
        uploadedBy: OWNER_ACTOR,
      });
      expect(stored.id).toMatch(/^msa_[a-z0-9]{10,32}$/);
      expect(stored.messageId).toBeUndefined();
      // The name is metadata only: it never reaches the disk.
      expect(stored.fileName).not.toContain('/');
      expect(filesOf()).toEqual([stored.id]);
    });

    it('proves the type from the content, not from the name', async () => {
      const html = await put(Buffer.from('<!doctype html><script>alert(1)</script>'), {
        fileName: 'pic.png',
      });
      expect(html).toMatchObject({ mediaType: 'application/octet-stream', preview: 'none' });
      const pdf = await put(pdfBytes(), { fileName: 'a.txt' });
      expect(pdf).toMatchObject({ mediaType: 'application/pdf', preview: 'pdf' });
    });

    it('takes exactly the size limit and refuses one byte more, leaving nothing behind', async () => {
      const exact = Buffer.concat([pngBytes(), Buffer.alloc(MAX_ATTACHMENT_BYTES - pngBytes().length)]);
      expect((await put(exact)).size).toBe(MAX_ATTACHMENT_BYTES);
      const before = filesOf();
      const err = await rejection(put(Buffer.concat([exact, Buffer.from([1])])));
      expect(err).toMatchObject({ code: 'attachment_too_large', status: 413 });
      expect(filesOf()).toEqual(before);
      expect(h.repos.messageAttachments.inState('pending')).toEqual([]);
    });

    it('lets at most 20 unsent files wait per uploader, counted for each uploader on its own', async () => {
      for (let i = 0; i < MAX_UNSENT_MESSAGE_ATTACHMENTS; i += 1) await put(pngBytes(), { actor: dev1 });
      const err = await rejection(put(pngBytes(), { actor: dev1 }));
      expect(err).toMatchObject({
        code: 'message_attachment_limit',
        status: 409,
        details: { max: MAX_UNSENT_MESSAGE_ATTACHMENTS },
      });
      // Another uploader is not held back, and a sent file no longer counts.
      await put(pngBytes(), { actor: OWNER_ACTOR });
      const waiting = h.repos.messageAttachments.unsentOf('AR', dev1);
      await send(
        waiting.slice(0, 3).map((record) => record.id),
        { from: 'dev-1', to: ['owner'], text: 'Files for you.' },
      );
      await put(pngBytes(), { actor: dev1 });
    });

    it('refuses a stranger to the project', async () => {
      const err = await rejection(put(pngBytes(), { actor: aiActor('stranger') }));
      expect(err).toMatchObject({ code: 'not_a_member' });
      expect(filesOf()).toEqual([]);
    });
  });

  describe('sending', () => {
    it('binds the file to the message and records it with the message', async () => {
      const a = await put(pngBytes(), { fileName: 'one.png' });
      const b = await put(pdfBytes(), { fileName: 'two.pdf' });
      const message = await send([a.id, b.id]);
      expect(message.attachments).toEqual([
        { id: a.id, fileName: 'one.png', size: a.size, mediaType: 'image/png', preview: 'image' },
        { id: b.id, fileName: 'two.pdf', size: b.size, mediaType: 'application/pdf', preview: 'pdf' },
      ]);
      expect(h.repos.messages.get(message.id)?.attachments).toEqual(message.attachments);
      expect(h.repos.messageAttachments.get(a.id)?.messageId).toBe(message.id);
    });

    it('sends a message of files alone, with no text', async () => {
      const a = await put();
      const message = await send([a.id], { text: '   ' });
      expect(message.body).toBe('');
      expect(message.attachments).toHaveLength(1);
      // Without files an empty text is still refused.
      expect(await rejection(send([], { text: ' ' }))).toMatchObject({ code: 'invalid_request' });
    });

    it('refuses a file of someone else, one already sent and one not ready, and sends nothing', async () => {
      const theirs = await put(pngBytes(), { actor: dev1 });
      const sentAlready = await put();
      await send([sentAlready.id]);
      const pending = h.repos.messageAttachments.insertPending({
        id: 'msa_pending0001',
        projectKey: 'AR',
        fileName: 'half.png',
        uploadedBy: OWNER_ACTOR,
        createdAt: clock.toISOString(),
      });
      void pending;
      const mine = await put();
      const messagesBefore = h.repos.messages.pending('AR', 'dev-1').length;

      for (const id of [theirs.id, sentAlready.id, 'msa_pending0001', 'msa_unknown0001']) {
        const err = await rejection(send([mine.id, id]));
        expect(err).toMatchObject({ code: 'message_attachment_unavailable', status: 409, details: { id } });
      }
      // Nothing was sent, and the good file stays unsent and its uploader's.
      expect(h.repos.messages.pending('AR', 'dev-1')).toHaveLength(messagesBefore);
      expect(h.repos.messageAttachments.get(mine.id)?.messageId).toBeUndefined();
      expect(h.repos.messageAttachments.get(theirs.id)?.messageId).toBeUndefined();
    });

    it('refuses a file of another project', async () => {
      const a = await put();
      h.repos.messageAttachments.insertPending({
        id: 'msa_otherproj01',
        projectKey: 'OTHER',
        fileName: 'x.png',
        uploadedBy: OWNER_ACTOR,
        createdAt: clock.toISOString(),
      });
      h.repos.messageAttachments.markReady('msa_otherproj01', {
        size: 1,
        mediaType: 'image/png',
        preview: 'image',
      });
      const err = await rejection(send([a.id, 'msa_otherproj01']));
      expect(err).toMatchObject({
        code: 'message_attachment_unavailable',
        details: { id: 'msa_otherproj01' },
      });
    });

    it('keeps old rows without the column as they were', async () => {
      const message = await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Plain.' });
      expect(h.repos.messages.get(message.id)?.attachments).toBeUndefined();
      expect(message).not.toHaveProperty('attachments');
    });
  });

  describe('delivery', () => {
    const block = (id: string, name: string, type: string, size: string, tail = '') =>
      `- ${id} ${JSON.stringify(name)} ${type}, ${size}${tail}`;

    it('puts the block under the text of a message typed into a running session', async () => {
      const session = (await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' })).session;
      const a = await put(pngBytes(245_100), { fileName: 'kepernyokep "1".png' });
      await send([a.id], { text: 'Look.' });
      await flush();
      expect(h.runner.messages).toEqual([
        {
          sessionId: session.id,
          text:
            '[team message from owner]\nLook.\n\nAttachments (open with read_message_attachment):\n' +
            block(a.id, 'kepernyokep "1".png', 'image/png', '245.1 kB'),
        },
      ]);
    });

    it('sends only the block for a message without text', async () => {
      const session = (await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' })).session;
      const a = await put();
      await send([a.id], { text: '' });
      await flush();
      const typed = h.runner.messages.filter((m) => m.sessionId === session.id);
      expect(typed).toHaveLength(1);
      expect(typed[0]!.text).toBe(
        '[team message from owner]\nAttachments (open with read_message_attachment):\n' +
          block(a.id, 'shot.png', 'image/png', '64 B'),
      );
    });

    it('puts each message’s block under its own text in a batch', async () => {
      await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
      const reviewer = (await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' }))
        .session;
      h.runner.setState(reviewer.id, 'working');
      // From an AI member, so that the messages wait for the busy session (a person's are typed at once).
      const a = await put(pngBytes(), { fileName: 'first.png', actor: dev1 });
      const b = await put(pdfBytes(), { fileName: 'second.pdf', actor: dev1 });
      const from = { from: 'dev-1', to: ['cr'], taskKey: 'AR-1' };
      await send([a.id], { ...from, text: 'First' });
      await send([], { ...from, text: 'Second' });
      await send([b.id], { ...from, text: 'Third' });
      await flush();
      expect(h.runner.messages).toHaveLength(0);
      h.runner.setState(reviewer.id, 'idle');
      await vi.waitFor(() => expect(h.runner.messages).toHaveLength(1));
      const text = h.runner.messages[0]!.text;
      expect(text).toContain('[team messages about AR-1]');
      expect(text.indexOf('First')).toBeLessThan(text.indexOf(a.id));
      expect(text.indexOf(a.id)).toBeLessThan(text.indexOf('Second'));
      expect(text.indexOf('Second')).toBeLessThan(text.indexOf('Third'));
      expect(text.indexOf('Third')).toBeLessThan(text.indexOf(b.id));
      expect(text).toContain(block(b.id, 'second.pdf', 'application/pdf', `${b.size} B`));
      expect(text).toContain(block(a.id, 'first.png', 'image/png', '64 B'));
    });
  });

  describe('who sees a file', () => {
    it('shows an unsent file to its uploader alone', async () => {
      const a = await put();
      const content = await h.domain.messageAttachments.open('AR', a.id, OWNER_ACTOR);
      expect(content.attachment.id).toBe(a.id);
      content.stream.destroy();
      for (const actor of [dev1, aiActor('cr')]) {
        expect(await rejection(h.domain.messageAttachments.open('AR', a.id, actor))).toMatchObject({
          code: 'not_found',
          status: 404,
        });
      }
    });

    it('shows a sent file to the participants and the owner, and to no other member', async () => {
      const a = await put();
      await send([a.id], { to: ['dev-1'] });
      for (const actor of [OWNER_ACTOR, dev1]) {
        const content = await h.domain.messageAttachments.open('AR', a.id, actor);
        content.stream.destroy();
      }
      const err = await rejection(h.domain.messageAttachments.open('AR', a.id, aiActor('dev-2')));
      expect(err).toMatchObject({ code: 'not_found', status: 404 });
      expect(
        await rejection(h.domain.messageAttachments.thumbnail('AR', a.id, aiActor('dev-2'))),
      ).toMatchObject({ code: 'not_found' });
    });
  });

  describe('deleting', () => {
    it('removes the file and the row, marks the message entry gone and publishes the update', async () => {
      const a = await put(pngBytes(), { fileName: 'secret.png' });
      const keep = await put(pdfBytes(), { fileName: 'keep.pdf' });
      const message = await send([a.id, keep.id]);
      // The delivery receipt is published after the send; it is not part of what the deletion does.
      await flush();
      const timelineBefore = h.repos.timeline.list('AR', {}).map((e) => e.id);
      const seen = events();

      await h.domain.messageAttachments.delete('AR', a.id, OWNER_ACTOR);

      expect(h.repos.messageAttachments.get(a.id)).toBeNull();
      expect(filesOf()).toEqual([keep.id]);
      const stored = h.repos.messages.get(message.id)!;
      expect(stored.attachments).toEqual([
        expect.objectContaining({ id: a.id, goneAt: clock.toISOString(), goneBy: OWNER_ACTOR }),
        expect.objectContaining({ id: keep.id }),
      ]);
      expect(stored.attachments![1]).not.toHaveProperty('goneAt');
      const updates = seen.filter((e) => e.type === 'team_message_updated');
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ projectKey: 'AR', message: { id: message.id } });
      // The message is not a new one: no `team_message` event and no timeline entry.
      expect(seen.filter((e) => e.type === 'team_message')).toEqual([]);
      expect(h.repos.timeline.list('AR', {}).map((e) => e.id)).toEqual(timelineBefore);
      // The file is gone for everyone, the owner included.
      expect(await rejection(h.domain.messageAttachments.open('AR', a.id, OWNER_ACTOR))).toMatchObject({
        code: 'not_found',
      });
    });

    it('lets the uploader, an owner or an admin delete, and refuses a viewer of the message who is none', async () => {
      const a = await put(pngBytes(), { actor: dev1 });
      await send([a.id], { from: 'dev-1', to: ['dev-2'], text: 'x' });
      // dev-2 sees the message but did not upload the file.
      expect(await rejection(h.domain.messageAttachments.delete('AR', a.id, aiActor('dev-2')))).toMatchObject(
        {
          code: 'insufficient_access',
          status: 403,
        },
      );
      expect(h.repos.messageAttachments.get(a.id)).toBeDefined();
      // Someone who cannot see the message gets a 404 rather than a 403.
      expect(await rejection(h.domain.messageAttachments.delete('AR', a.id, aiActor('cr')))).toMatchObject({
        code: 'not_found',
        status: 404,
      });
      await h.domain.messageAttachments.delete('AR', a.id, dev1);
      expect(h.repos.messageAttachments.get(a.id)).toBeNull();
    });

    it('deletes an unsent file without touching any message', async () => {
      const a = await put();
      const seen = events();
      await h.domain.messageAttachments.delete('AR', a.id, OWNER_ACTOR);
      expect(filesOf()).toEqual([]);
      expect(seen.filter((e) => e.type === 'team_message_updated')).toEqual([]);
    });
  });

  describe('recovery and the sweep', () => {
    it('removes an upload that never completed and finishes a deletion under way', async () => {
      const done = await put();
      const sent = await put();
      const message = await send([sent.id]);
      h.repos.messageAttachments.insertPending({
        id: 'msa_halfway0001',
        projectKey: 'AR',
        fileName: 'half.png',
        uploadedBy: OWNER_ACTOR,
        createdAt: clock.toISOString(),
      });
      writeFileSync(join(h.messageAttachmentsDir, 'AR', 'msa_halfway0001.part'), 'half');
      h.repos.messageAttachments.markDeleting(sent.id, OWNER_ACTOR, clock.toISOString());

      const next = await restartDomainHarness(h, { now: () => clock });
      open.splice(open.indexOf(h), 1, next);

      expect(next.repos.messageAttachments.get('msa_halfway0001')).toBeNull();
      expect(next.repos.messageAttachments.get(sent.id)).toBeNull();
      expect(filesOf(next)).toEqual([done.id]);
      expect(next.repos.messages.get(message.id)?.attachments?.[0]).toMatchObject({
        id: sent.id,
        goneBy: OWNER_ACTOR,
      });
    });

    it('sweeps the unsent uploads older than 24 hours and leaves the rest', async () => {
      const old = await put();
      const oldSent = await put();
      await send([oldSent.id]);
      clock = new Date(clock.getTime() + 23 * 3600_000);
      const young = await put();
      clock = new Date(clock.getTime() + 2 * 3600_000);

      expect(await h.domain.messageAttachments.sweepUnsent()).toBe(1);

      expect(h.repos.messageAttachments.get(old.id)).toBeNull();
      expect(h.repos.messageAttachments.get(young.id)).toBeDefined();
      expect(h.repos.messageAttachments.get(oldSent.id)).toBeDefined();
      expect(filesOf().sort()).toEqual([oldSent.id, young.id].sort());
    });
  });

  describe('reading (read_message_attachment)', () => {
    const readAs = (handle: string, id: string) =>
      h.domain.messageAttachments.reading('AR', id, aiViewer(handle));

    it('returns an image as WebP, the first frame, at most 1568 px, never enlarged', async () => {
      const big = await put(await realPng(4000, 2000), { fileName: 'wide.png' });
      const small = await put(await realPng(300, 200), { fileName: 'small.png' });
      await send([big.id, small.id]);

      const wide = await readAs('dev-1', big.id);
      expect(wide.attachment).toMatchObject({ id: big.id, fileName: 'wide.png' });
      expect(wide.message).toMatchObject({ from: 'owner' });
      if (wide.content.kind !== 'image') throw new Error('expected an image');
      expect(wide.content.mimeType).toBe('image/webp');
      expect(wide.content.data.length).toBeLessThanOrEqual(1_500_000);
      expect(await sharp(wide.content.data).metadata()).toMatchObject({
        format: 'webp',
        width: 1568,
        height: 784,
      });

      const little = await readAs('dev-1', small.id);
      if (little.content.kind !== 'image') throw new Error('expected an image');
      expect(await sharp(little.content.data).metadata()).toMatchObject({ width: 300, height: 200 });
    });

    it('says too_large when the renderer cannot get the image under the byte limit', async () => {
      // A WebP of a 1568 px picture stays under 1.5 MB even for noise, so the renderer's answer is faked.
      vi.spyOn(MessageImageRenderer.prototype, 'render').mockResolvedValue(null);
      const a = await put(await realPng(100, 100), { fileName: 'busy.png' });
      await send([a.id]);
      expect((await readAs('dev-1', a.id)).content).toEqual({ kind: 'none', reason: 'too_large' });
    });

    it('re-encodes at the lower quality when the first WebP is over the byte limit', async () => {
      const noise = await sharp(randomBytes(1568 * 1568 * 3), {
        raw: { width: 1568, height: 1568, channels: 3 },
      })
        .png({ compressionLevel: 1 })
        .toBuffer();
      const renderer = new MessageImageRenderer();
      const webp = await renderer.render(noise);
      // Whatever the quality it settled on, the bytes it hands out are within the limit.
      if (webp) expect(webp.length).toBeLessThanOrEqual(MESSAGE_IMAGE_MAX_BYTES);
      expect(webp === null || (await sharp(webp).metadata()).width === 1568).toBe(true);
    }, 60_000);

    it('gives an image that cannot be decoded as a file of no readable type', async () => {
      const a = await put(pngBytes(200));
      await send([a.id]);
      expect((await readAs('dev-1', a.id)).content).toEqual({ kind: 'none', reason: 'type' });
    });

    it('gives a small UTF-8 text as text, and anything else by name only', async () => {
      const text = await put(Buffer.from('Üzenet\nsecond line\n'), { fileName: 'jegyzet.txt' });
      const binary = await put(Buffer.concat([Buffer.from('abc'), Buffer.from([0, 1, 2])]), {
        fileName: 'data.bin',
      });
      const latin1 = await put(Buffer.from([0x61, 0xe9, 0x62]), { fileName: 'latin.txt' });
      const huge = await put(Buffer.alloc(100_001, 0x61), { fileName: 'big.txt' });
      const pdf = await put(pdfBytes(), { fileName: 'jegyzet.pdf' });
      await send([text.id, binary.id, latin1.id, huge.id, pdf.id]);

      expect((await readAs('dev-1', text.id)).content).toEqual({
        kind: 'text',
        text: 'Üzenet\nsecond line\n',
      });
      for (const file of [binary, latin1, huge, pdf])
        expect((await readAs('dev-1', file.id)).content).toEqual({ kind: 'none', reason: 'type' });
    });

    it('reads a text of exactly 100 000 bytes', async () => {
      const exact = await put(Buffer.alloc(100_000, 0x61), { fileName: 'exact.txt' });
      await send([exact.id]);
      const reading = await readAs('dev-1', exact.id);
      expect(reading.content.kind).toBe('text');
    });

    it('does not find an unsent file, a deleted one or one of a message the reader cannot see', async () => {
      const unsent = await put();
      const sent = await put(Buffer.from('hello'), { fileName: 'hello.txt' });
      await send([sent.id], { to: ['dev-1'] });
      const gone = await put(Buffer.from('bye'), { fileName: 'bye.txt' });
      await send([gone.id], { to: ['dev-1'] });
      await h.domain.messageAttachments.delete('AR', gone.id, OWNER_ACTOR);

      for (const [handle, id] of [
        ['dev-1', unsent.id],
        ['dev-1', gone.id],
        ['dev-2', sent.id],
        ['cr', sent.id],
        ['dev-1', 'msa_unknown0001'],
      ] as const) {
        expect(await rejection(readAs(handle, id))).toMatchObject({ code: 'not_found' });
      }
      expect((await readAs('dev-1', sent.id)).content.kind).toBe('text');
    });

    describe('as a team tool', () => {
      let ctxOf: (member: string) => Promise<ToolContext>;
      beforeEach(async () => {
        await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
        ctxOf = async (member) => {
          const started = await h.domain.taskStarts.start('AR', 'AR-1', {
            actor: OWNER_ACTOR,
            author: OWNER,
            ...(member === 'dev-1' ? {} : { assignee: member }),
          });
          return { sessionId: started.session!.id, projectKey: 'AR', member, taskKey: 'AR-1' };
        };
      });

      it('judges the file through the calling member, and refuses a bad id', async () => {
        const a = await put(Buffer.from('shared note'), { fileName: 'note.txt' });
        await send([a.id], { to: ['dev-1'] });
        const dev = await ctxOf('dev-1');
        const reading = await h.domain.teamTools.readMessageAttachment(dev, { attachmentId: a.id });
        expect(reading.content).toEqual({ kind: 'text', text: 'shared note' });

        const bad = await rejection(
          h.domain.teamTools.readMessageAttachment(dev, { attachmentId: '../etc/passwd' }),
          TeamToolError,
        );
        expect(bad.code).toBe('invalid');
        const missing = await rejection(
          h.domain.teamTools.readMessageAttachment(dev, { attachmentId: 'msa_unknown0001' }),
          TeamToolError,
        );
        expect(missing.code).toBe('not_found');
      });
    });
  });

  it('keeps the files private to the server user', async () => {
    const a = await put();
    expect(statSync(join(h.messageAttachmentsDir, 'AR')).mode & 0o777).toBe(0o700);
    expect(statSync(join(h.messageAttachmentsDir, 'AR', a.id)).mode & 0o777).toBe(0o600);
  });
});

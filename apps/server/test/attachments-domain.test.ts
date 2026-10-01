import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTACHMENT_BYTES } from '@projectman/shared';
import type { Attachment, ServerEvent } from '@projectman/shared';
import type { AttachmentStorage } from '../src/contracts';
import { aiActor } from '../src/domain';
import { pngBytes } from './helpers/attachments';
import { createDomainHarness, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/** Faults the wrapped storage injects while they are set. */
interface Faults {
  create?: Error;
  /** Fails the write after the first chunk went to disk. */
  write?: Error;
  publish?: Error;
  openRead?: Error;
  remove?: Error;
}

function faultyStorage(faults: Faults) {
  return (inner: AttachmentStorage): AttachmentStorage => ({
    async create(ref) {
      if (faults.create) throw faults.create;
      const writer = await inner.create(ref);
      const failing = new Writable({
        write(chunk: Buffer, _encoding, done) {
          writer.stream.write(chunk, (err) => done(err ?? faults.write));
        },
        destroy(err, done) {
          writer.stream.destroy();
          done(err);
        },
      });
      return {
        stream: faults.write ? failing : writer.stream,
        async publish() {
          if (faults.publish) {
            await writer.discard();
            throw faults.publish;
          }
          return writer.publish();
        },
        discard: () => writer.discard(),
      };
    },
    openRead: (ref, size) => (faults.openRead ? Promise.reject(faults.openRead) : inner.openRead(ref, size)),
    async remove(ref) {
      if (faults.remove) throw faults.remove;
      return inner.remove(ref);
    },
    removeTemporary: (ref) => inner.removeTemporary(ref),
    scan: () => inner.scan(),
  });
}

const diskError = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

describe('attachments service', () => {
  const open: DomainHarness[] = [];
  afterEach(async () => {
    for (const h of open.splice(0).reverse()) await h.cleanup();
  });

  async function harness(opts: Parameters<typeof createDomainHarness>[0] = {}) {
    const h = await createDomainHarness(opts);
    open.push(h);
    await h.domain.tasks.create('AR', { title: 'Fictional checkout' }, OWNER_ACTOR);
    return h;
  }

  /** The harness after a restart over the same files; the earlier one is no longer cleaned up. */
  async function restarted(h: DomainHarness, opts: Parameters<typeof createDomainHarness>[0] = {}) {
    const next = await restartDomainHarness(h, opts);
    open.splice(open.indexOf(h), 1, next);
    return next;
  }

  const put = (
    h: DomainHarness,
    content: Buffer | Readable = pngBytes(),
    opts: {
      actor?: Parameters<DomainHarness['domain']['attachments']['upload']>[0]['actor'];
      taskKey?: string;
    } = {},
  ): Promise<Attachment> =>
    h.domain.attachments.upload({
      projectKey: 'AR',
      taskKey: opts.taskKey ?? 'AR-1',
      actor: opts.actor ?? OWNER_ACTOR,
      fileName: 'a.png',
      content: Buffer.isBuffer(content) ? Readable.from([content]) : content,
    });

  const attachmentEvents = (h: DomainHarness) =>
    h.repos.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.type.startsWith('attachment_'));
  const filesOf = (h: DomainHarness, taskKey = 'AR-1') => {
    try {
      return readdirSync(join(h.attachmentsDir, 'AR', taskKey)).sort();
    } catch {
      return [];
    }
  };
  /** Collects what the server would send to browsers. */
  const record = (h: DomainHarness): ServerEvent[] => {
    const events: ServerEvent[] = [];
    h.domain.bus.subscribe((event) => events.push(event));
    return events;
  };
  const changes = (events: ServerEvent[]) => events.filter((e) => e.type === 'task_attachments_changed');
  const pendingRows = (h: DomainHarness) => h.repos.attachments.inState('pending');
  const nothingBehind = (h: DomainHarness, events: ServerEvent[]) => {
    expect(pendingRows(h)).toEqual([]);
    expect(filesOf(h)).toEqual([]);
    expect(attachmentEvents(h)).toEqual([]);
    expect(changes(events)).toEqual([]);
  };
  /** A source of `count` chunks of `size` bytes (and a last one of `extra` bytes), produced lazily. */
  const chunks = (count: number, size: number, extra = 0) =>
    Readable.from(
      (function* () {
        for (let i = 0; i < count; i++) yield Buffer.alloc(size, 1);
        if (extra > 0) yield Buffer.alloc(extra, 1);
      })(),
    );

  describe('uploading', () => {
    it('takes exactly the maximum, however the bytes are chunked, and refuses one more', async () => {
      const h = await harness();
      const exact = await put(h, chunks(25, 1_000_000));
      expect(exact.size).toBe(MAX_ATTACHMENT_BYTES);
      expect(filesOf(h)).toEqual([exact.id]);

      const events = record(h);
      await expect(put(h, chunks(25, 1_000_000, 1))).rejects.toMatchObject({
        code: 'attachment_too_large',
        status: 413,
      });
      expect(filesOf(h)).toEqual([exact.id]);
      expect(pendingRows(h)).toEqual([]);
      expect(changes(events)).toEqual([]);
      expect(attachmentEvents(h)).toHaveLength(1);
    }, 30_000);

    it('counts what arrives, not what a header or a field claims', async () => {
      const h = await harness();
      const attachment = await put(h, Readable.from([Buffer.alloc(10), Buffer.alloc(5), Buffer.alloc(1)]));
      expect(attachment.size).toBe(16);
      expect(statSizeOf(h, attachment)).toBe(16);
    });

    it('proves the media type from the first bytes even when they arrive in tiny chunks', async () => {
      const h = await harness();
      const png = pngBytes(40);
      const pieces = [...png].map((byte) => Buffer.from([byte]));
      const attachment = await put(h, Readable.from(pieces));
      expect(attachment).toMatchObject({ mediaType: 'image/png', preview: 'image', size: 40 });
    });

    it('leaves nothing behind when the disk fails: no file, row, event or notice', async () => {
      const faults: Faults = {};
      const h = await harness({ attachmentStorage: faultyStorage(faults) });
      const events = record(h);

      faults.create = diskError('EACCES');
      await expect(put(h)).rejects.toMatchObject({ code: 'attachment_storage_failed', status: 500 });
      nothingBehind(h, events);
      faults.create = undefined;

      faults.write = diskError('ENOSPC');
      await expect(put(h, chunks(5, 100_000))).rejects.toMatchObject({ code: 'attachment_storage_failed' });
      nothingBehind(h, events);
      faults.write = undefined;

      faults.publish = diskError('EIO');
      await expect(put(h)).rejects.toMatchObject({ code: 'attachment_storage_failed' });
      nothingBehind(h, events);
      faults.publish = undefined;

      expect(h.log.errors).toHaveLength(3);
      h.log.errors.length = 0;
      // And the next upload works.
      expect((await put(h)).size).toBe(64);
    });

    it('takes back the file when the database fails at the end', async () => {
      const h = await harness();
      const events = record(h);
      const failure = new Error('database is locked');
      const spy = vi.spyOn(h.repos.attachments, 'markReady').mockImplementation(() => {
        throw failure;
      });
      await expect(put(h)).rejects.toBe(failure);
      spy.mockRestore();
      nothingBehind(h, events);
    });

    it('takes back the file when the audit event cannot be written', async () => {
      const h = await harness();
      const events = record(h);
      const spy = vi.spyOn(h.repos.timeline, 'insert').mockImplementation(() => {
        throw new Error('disk image is malformed');
      });
      await expect(put(h)).rejects.toThrow('disk image is malformed');
      spy.mockRestore();
      nothingBehind(h, events);
      // The unit of work rolled the row's state back with it, and the rest was cleaned up.
      expect(h.repos.attachments.ids().size).toBe(0);
    });

    it('cleans up after a source that breaks off', async () => {
      const h = await harness();
      const events = record(h);
      const source = new Readable({
        read() {
          this.push(Buffer.alloc(1000));
          setImmediate(() => this.destroy(new Error('connection reset')));
        },
      });
      await expect(put(h, source)).rejects.toMatchObject({ code: 'invalid_request' });
      nothingBehind(h, events);
    });

    it('refuses a viewer, a stranger and a task nobody sees before it stores anything', async () => {
      const h = await harness();
      await expect(put(h, pngBytes(), { actor: { kind: 'human', handle: 'nobody' } })).rejects.toMatchObject({
        code: 'not_a_member',
      });
      await expect(put(h, pngBytes(), { actor: { kind: 'system', handle: null } })).rejects.toMatchObject({
        code: 'not_a_member',
      });
      await expect(put(h, pngBytes(), { actor: { kind: 'ai', handle: 'owner' } })).rejects.toMatchObject({
        code: 'not_a_member',
      });
      await expect(put(h, pngBytes(), { taskKey: 'AR-9' })).rejects.toMatchObject({ code: 'not_found' });
      expect(h.repos.attachments.ids().size).toBe(0);
      expect(filesOf(h)).toEqual([]);
    });

    it('lets an AI member upload, attributed to it', async () => {
      const h = await harness();
      const attachment = await put(h, pngBytes(), { actor: aiActor('dev-1') });
      expect(attachment.uploadedBy).toEqual({ kind: 'ai', handle: 'dev-1' });
      expect(attachmentEvents(h)[0]).toMatchObject({ actor: { kind: 'ai', handle: 'dev-1' } });
    });
  });

  describe('opening', () => {
    it('serves only a ready attachment of the right task, and the bytes as stored', async () => {
      const h = await harness();
      await h.domain.tasks.create('AR', { title: 'Another' }, OWNER_ACTOR);
      const bytes = pngBytes(5000);
      const attachment = await put(h, bytes);
      const { stream } = await h.domain.attachments.open('AR', 'AR-1', attachment.id, OWNER_ACTOR);
      expect(Buffer.concat(await stream.toArray()).equals(bytes)).toBe(true);
      await expect(h.domain.attachments.open('AR', 'AR-2', attachment.id, OWNER_ACTOR)).rejects.toMatchObject(
        {
          code: 'not_found',
        },
      );

      // A pending row (an upload under way, or left by a crash) is not readable.
      h.repos.attachments.insertPending({
        id: 'att_pendingonly01',
        projectKey: 'AR',
        taskKey: 'AR-1',
        fileName: 'x',
        uploadedBy: OWNER_ACTOR,
        createdAt: new Date().toISOString(),
      });
      await expect(
        h.domain.attachments.open('AR', 'AR-1', 'att_pendingonly01', OWNER_ACTOR),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(await h.domain.attachments.list('AR', 'AR-1', OWNER_ACTOR)).toEqual([attachment]);
    });

    it('reports a missing or altered file as a storage failure, never as someone else`s bytes', async () => {
      const h = await harness();
      const attachment = await put(h, pngBytes(100));
      writeFileSync(join(h.attachmentsDir, 'AR', 'AR-1', attachment.id), 'tampered with: another length');
      await expect(h.domain.attachments.open('AR', 'AR-1', attachment.id, OWNER_ACTOR)).rejects.toMatchObject(
        {
          code: 'attachment_storage_failed',
        },
      );
      rmSync(join(h.attachmentsDir, 'AR', 'AR-1', attachment.id));
      await expect(h.domain.attachments.open('AR', 'AR-1', attachment.id, OWNER_ACTOR)).rejects.toMatchObject(
        {
          code: 'attachment_storage_failed',
        },
      );
      h.log.errors.length = 0;
    });
  });

  describe('deleting', () => {
    it('reports success only after the file is gone and the metadata and audit are final', async () => {
      const faults: Faults = {};
      const h = await harness({ attachmentStorage: faultyStorage(faults) });
      const attachment = await put(h, pngBytes(), { actor: aiActor('dev-1') });
      const events = record(h);

      faults.remove = diskError('EIO');
      await expect(
        h.domain.attachments.delete('AR', 'AR-1', attachment.id, aiActor('dev-1')),
      ).rejects.toMatchObject({ code: 'attachment_storage_failed' });
      // The intent is durable; the file is still there; nothing is reported as deleted.
      expect(h.repos.attachments.get(attachment.id)).toMatchObject({
        state: 'deleting',
        deletedBy: { kind: 'ai', handle: 'dev-1' },
      });
      expect(filesOf(h)).toEqual([attachment.id]);
      expect(attachmentEvents(h).map((e) => e.type)).toEqual(['attachment_added']);
      expect(changes(events)).toEqual([]);
      // A deletion under way is gone for readers.
      expect(await h.domain.attachments.list('AR', 'AR-1', OWNER_ACTOR)).toEqual([]);
      await expect(h.domain.attachments.open('AR', 'AR-1', attachment.id, OWNER_ACTOR)).rejects.toMatchObject(
        {
          code: 'not_found',
        },
      );

      // Trying again finishes it as it was asked for, once: the audit names who asked first.
      faults.remove = undefined;
      await h.domain.attachments.delete('AR', 'AR-1', attachment.id, OWNER_ACTOR);
      expect(filesOf(h)).toEqual([]);
      expect(h.repos.attachments.get(attachment.id)).toBeNull();
      expect(attachmentEvents(h).filter((e) => e.type === 'attachment_deleted')).toMatchObject([
        { actor: { kind: 'ai', handle: 'dev-1' }, data: { attachmentId: attachment.id, fileName: 'a.png' } },
      ]);
      expect(changes(events)).toHaveLength(1);
      h.log.errors.length = 0;
    });

    it('does not report success, or write the event, when the database fails after the file is gone', async () => {
      const h = await harness();
      const attachment = await put(h);
      const events = record(h);
      const spy = vi.spyOn(h.repos.timeline, 'insert').mockImplementationOnce(() => {
        throw new Error('database is locked');
      });
      await expect(h.domain.attachments.delete('AR', 'AR-1', attachment.id, OWNER_ACTOR)).rejects.toThrow(
        'database is locked',
      );
      spy.mockRestore();
      // File gone, row rolled back to its intent, no event, no notice.
      expect(filesOf(h)).toEqual([]);
      expect(h.repos.attachments.get(attachment.id)?.state).toBe('deleting');
      expect(attachmentEvents(h).map((e) => e.type)).toEqual(['attachment_added']);
      expect(changes(events)).toEqual([]);

      await h.domain.attachments.delete('AR', 'AR-1', attachment.id, OWNER_ACTOR);
      expect(attachmentEvents(h).map((e) => e.type)).toEqual(['attachment_added', 'attachment_deleted']);
    });

    it('writes one event when the same attachment is deleted twice at once', async () => {
      const h = await harness();
      const attachment = await put(h);
      const results = await Promise.allSettled([
        h.domain.attachments.delete('AR', 'AR-1', attachment.id, OWNER_ACTOR),
        h.domain.attachments.delete('AR', 'AR-1', attachment.id, OWNER_ACTOR),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'not_found' } });
      expect(attachmentEvents(h).filter((e) => e.type === 'attachment_deleted')).toHaveLength(1);
    });

    it('keeps the audit trail after the attachment is gone', async () => {
      const h = await harness();
      const attachment = await put(h);
      await h.domain.attachments.delete('AR', 'AR-1', attachment.id, OWNER_ACTOR);
      expect(attachmentEvents(h)).toMatchObject([
        { type: 'attachment_added', actor: OWNER_ACTOR, data: { fileName: 'a.png', size: 64 } },
        {
          type: 'attachment_deleted',
          actor: OWNER_ACTOR,
          data: { attachmentId: attachment.id, fileName: 'a.png' },
        },
      ]);
    });
  });

  describe('after a restart', () => {
    it('still has the attachments: list, content and the audit', async () => {
      const h = await harness({ persistent: true });
      const bytes = pngBytes(777);
      const attachment = await put(h, bytes);
      const next = await restarted(h, { persistent: true });
      expect(await next.domain.attachments.list('AR', 'AR-1', OWNER_ACTOR)).toEqual([attachment]);
      const { stream } = await next.domain.attachments.open('AR', 'AR-1', attachment.id, OWNER_ACTOR);
      expect(Buffer.concat(await stream.toArray()).equals(bytes)).toBe(true);
      expect(attachmentEvents(next)).toHaveLength(1);
    });

    it.each([
      ['the intent was recorded, the file is still there', false],
      ['the file was removed, the row was not', true],
    ])('finishes a deletion that was cut short when %s, once', async (_, fileGone) => {
      const h = await harness({ persistent: true });
      const attachment = await put(h, pngBytes(), { actor: aiActor('dev-1') });
      expect(
        h.repos.attachments.markDeleting(attachment.id, aiActor('dev-1'), new Date().toISOString()),
      ).toBe(true);
      if (fileGone) rmSync(join(h.attachmentsDir, 'AR', 'AR-1', attachment.id));
      expect(attachmentEvents(h).map((e) => e.type)).toEqual(['attachment_added']);

      const next = await restarted(h, { persistent: true });
      expect(filesOf(next)).toEqual([]);
      expect(next.repos.attachments.get(attachment.id)).toBeNull();
      expect(attachmentEvents(next).filter((e) => e.type === 'attachment_deleted')).toMatchObject([
        { actor: { kind: 'ai', handle: 'dev-1' }, data: { attachmentId: attachment.id } },
      ]);
      // Another restart finds nothing to do and writes nothing more.
      const again = await restarted(next, { persistent: true });
      expect(attachmentEvents(again)).toHaveLength(2);
    });

    it('removes an upload that never completed, with its file and without an event', async () => {
      const h = await harness({ persistent: true });
      const row = (id: string) =>
        h.repos.attachments.insertPending({
          id,
          projectKey: 'AR',
          taskKey: 'AR-1',
          fileName: 'x.png',
          uploadedBy: OWNER_ACTOR,
          createdAt: new Date().toISOString(),
        });
      const dir = join(h.attachmentsDir, 'AR', 'AR-1');
      mkdirSync(dir, { recursive: true });
      // Cut short while writing, and cut short after the file was published.
      row('att_writing00001');
      writeFileSync(join(dir, 'att_writing00001.part'), 'half');
      row('att_published001');
      writeFileSync(join(dir, 'att_published001'), 'whole');
      // And a row whose file was never even created.
      row('att_nofile000001');

      const next = await restarted(h, { persistent: true });
      expect(filesOf(next)).toEqual([]);
      expect(pendingRows(next)).toEqual([]);
      expect(next.repos.attachments.ids().size).toBe(0);
      expect(attachmentEvents(next)).toEqual([]);
    });

    it('removes stray temporary files, and reports but keeps files that belong to nothing', async () => {
      const h = await harness({ persistent: true });
      const dir = join(h.attachmentsDir, 'AR', 'AR-1');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'att_stray0000001.part'), 'x');
      writeFileSync(join(dir, 'att_unknown00001'), 'x');
      const next = await restarted(h, { persistent: true });
      expect(filesOf(next)).toEqual(['att_unknown00001']);
      expect(next.log.warnings.length).toBeGreaterThan(0);
    });

    it('starts although a recovery step fails, and tries again at the next start', async () => {
      const faults: Faults = {};
      const h = await harness({ persistent: true });
      const attachment = await put(h);
      h.repos.attachments.markDeleting(attachment.id, OWNER_ACTOR, new Date().toISOString());
      faults.remove = diskError('EIO');
      const next = await restarted(h, { persistent: true, attachmentStorage: faultyStorage(faults) });
      expect(next.repos.attachments.get(attachment.id)?.state).toBe('deleting');
      expect(next.log.errors.length).toBeGreaterThan(0);
      next.log.errors.length = 0;
      const last = await restarted(next, { persistent: true });
      expect(last.repos.attachments.get(attachment.id)).toBeNull();
      expect(filesOf(last)).toEqual([]);
    });
  });

  describe('task lifecycle and backups', () => {
    it('keeps the attachments of a cancelled task and of the task when it is reopened', async () => {
      const h = await harness();
      const attachment = await put(h);
      await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
      expect(await h.domain.attachments.list('AR', 'AR-1', OWNER_ACTOR)).toEqual([attachment]);
      expect(filesOf(h)).toEqual([attachment.id]);
      await h.domain.tasks.reopen('AR', 'AR-1', OWNER_ACTOR);
      expect(await h.domain.attachments.list('AR', 'AR-1', OWNER_ACTOR)).toEqual([attachment]);
      const { stream } = await h.domain.attachments.open('AR', 'AR-1', attachment.id, OWNER_ACTOR);
      expect(Buffer.concat(await stream.toArray()).length).toBe(64);
    });

    it('restores from a copy of the whole home taken while the server was stopped, in isolation', async () => {
      const h = await harness({ persistent: true });
      const bytes = pngBytes(4096);
      const kept = await put(h, bytes);
      const deleted = await put(h);
      await h.domain.attachments.delete('AR', 'AR-1', deleted.id, OWNER_ACTOR);
      await h.domain.stop();
      h.repos.db.close();

      // The backup: everything under the home, as DEPLOY.md says; restored to another place.
      const restoredDir = mkdtempSync(join(tmpdir(), 'pm-restore-'));
      cpSync(h.dir, restoredDir, { recursive: true, preserveTimestamps: true });
      const restored = await createDomainHarness({ directory: restoredDir });
      try {
        expect(restored.dir).not.toBe(h.dir);
        expect(await restored.domain.attachments.list('AR', 'AR-1', OWNER_ACTOR)).toEqual([kept]);
        const { stream } = await restored.domain.attachments.open('AR', 'AR-1', kept.id, OWNER_ACTOR);
        expect(Buffer.concat(await stream.toArray()).equals(bytes)).toBe(true);
        expect(existsSync(join(restored.attachmentsDir, 'AR', 'AR-1', deleted.id))).toBe(false);
        // Private as before (DEPLOY.md: restore the modes too).
        expect(statSync(join(restored.attachmentsDir, 'AR', 'AR-1', kept.id)).mode & 0o777).toBe(0o600);
        expect(statSync(join(restored.attachmentsDir, 'AR', 'AR-1')).mode & 0o777).toBe(0o700);
        expect(statSync(restored.attachmentsDir).mode & 0o777).toBe(0o700);
        expect(readFileSync(join(restored.attachmentsDir, 'AR', 'AR-1', kept.id)).equals(bytes)).toBe(true);
        // The restored copy works on its own: deleting there leaves the original untouched.
        await restored.domain.attachments.delete('AR', 'AR-1', kept.id, OWNER_ACTOR);
        expect(existsSync(join(h.attachmentsDir, 'AR', 'AR-1', kept.id))).toBe(true);
        expect(
          restored.repos.timeline
            .list('AR', { taskKey: 'AR-1' })
            .filter((e) => e.type.startsWith('attachment_')),
        ).toHaveLength(4);
      } finally {
        await restored.cleanup();
        // The original harness was stopped by hand; its directory goes with the restored one.
        open.splice(open.indexOf(h), 1);
        rmSync(h.dir, { recursive: true, force: true });
      }
    });
  });
});

function statSizeOf(h: DomainHarness, attachment: Attachment): number {
  return readFileSync(join(h.attachmentsDir, attachment.projectKey, attachment.taskKey, attachment.id))
    .length;
}

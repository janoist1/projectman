import { Transform } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  attachmentPreviewOf,
  canDeleteAttachment,
  canReadAttachments,
  canUploadAttachment,
  MAX_ATTACHMENT_BYTES,
  memberOf,
} from '@projectman/shared';
import type { Actor, Attachment, AttachmentViewer, Task } from '@projectman/shared';
import type {
  AttachmentContent,
  AttachmentOperations,
  AttachmentRef,
  AttachmentStorage,
  AttachmentUploadInput,
  AttachmentWriter,
  LocatedAttachment,
} from '../../contracts';
import type { AttachmentRecord } from '../../db';
import { isoNow } from '../context';
import type { DomainContext } from '../context';
import { DomainError, forbidden, invalid, notFound } from '../errors';
import type { ProjectService } from '../projects';
import type { TaskService } from '../tasks';
import type { TimelineService } from '../timeline';
import { KeyedMutex, SYSTEM_ACTOR, newId } from '../util';
import { sanitizeFileName } from './file-name';
import { SNIFF_BYTES, sniffMediaType } from './media-type';
import { TEMPORARY_SUFFIX } from './storage';

const storageFailed = (message: string) =>
  new DomainError('attachment_storage_failed', message, { status: 500 });

/** Counts the bytes that pass, refuses the one that crosses the limit and keeps the first few for the content check. */
class UploadMeter extends Transform {
  size = 0;
  exceeded = false;
  head = Buffer.alloc(0);

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (err?: Error | null, data?: Buffer) => void,
  ) {
    if (this.size + chunk.length > MAX_ATTACHMENT_BYTES) {
      this.exceeded = true;
      done(new Error('attachment too large'));
      return;
    }
    if (this.head.length < SNIFF_BYTES) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, SNIFF_BYTES - this.head.length)]);
    }
    this.size += chunk.length;
    done(null, chunk);
  }
}

const toDto = (r: AttachmentRecord): Attachment => ({
  id: r.id,
  projectKey: r.projectKey,
  taskKey: r.taskKey,
  fileName: r.fileName,
  size: r.size,
  mediaType: r.mediaType,
  preview: r.preview,
  uploadedBy: r.uploadedBy,
  createdAt: r.createdAt,
});

/**
 * Files attached to tasks. The file system and SQLite share no transaction, so the order of the
 * steps and the durable state of the row (`pending`, `ready`, `deleting`) carry the guarantees:
 *
 * - an upload is a `pending` row and a temporary file; only after the whole stream was counted
 *   against the limit and the access was checked again is the file published and the row made
 *   `ready` together with the audit event; any failure removes both, and a crash leaves a row that
 *   `recover` removes;
 * - only a `ready` attachment can be read;
 * - a deletion first records the intent (`deleting`, with who asked), then removes the file, and
 *   only then removes the row and writes the audit event in one unit of work, so a failure or a
 *   stop in between never reports a success nor writes the event twice: `recover` or a repeated
 *   delete finishes it.
 *
 * Whoever calls (REST, the team tools) gets the same checks: the rules are those of `packages/shared`,
 * judged for the acting member against the current roster and the task's current visibility.
 */
export class AttachmentService implements AttachmentOperations {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly timeline: TimelineService;
  private readonly storage: AttachmentStorage;
  private readonly deletions = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    timeline: TimelineService;
    storage: AttachmentStorage;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.timeline = deps.timeline;
    this.storage = deps.storage;
  }

  async list(projectKey: string, taskKey: string, actor: Actor): Promise<Attachment[]> {
    await this.authorize(projectKey, taskKey, actor);
    return this.ctx.repos.attachments.listReady(projectKey, taskKey).map(toDto);
  }

  async assertCanUpload(projectKey: string, taskKey: string, actor: Actor): Promise<void> {
    await this.authorize(projectKey, taskKey, actor, 'upload');
  }

  async upload(input: AttachmentUploadInput): Promise<Attachment> {
    const { projectKey, taskKey, actor } = input;
    await this.authorize(projectKey, taskKey, actor, 'upload');

    const { repos } = this.ctx;
    const ref: AttachmentRef = { projectKey, taskKey, id: newId('att') };
    repos.attachments.insertPending({
      id: ref.id,
      projectKey,
      taskKey,
      fileName: sanitizeFileName(input.fileName),
      uploadedBy: actor,
      createdAt: isoNow(this.ctx),
    });
    let writer: AttachmentWriter | undefined;
    let published = false;
    try {
      writer = await this.createWriter(ref);
      const { size, head } = await this.receive(input.content, writer.stream);
      // The access may have changed while the bytes arrived (membership, the task's visibility).
      await this.authorize(projectKey, taskKey, actor, 'upload');
      await input.beforeCommit?.();
      await writer.publish().catch((err: unknown) => {
        this.ctx.logger.error({ err, attachment: ref.id }, 'attachment could not be published');
        throw storageFailed('the file could not be stored');
      });
      published = true;
      const mediaType = sniffMediaType(head);
      return this.ctx.unitOfWork(() => {
        const stored = { size, mediaType, preview: attachmentPreviewOf(mediaType) };
        if (!repos.attachments.markReady(ref.id, stored)) throw new Error('attachment row vanished');
        const record = repos.attachments.get(ref.id)!;
        this.timeline.append({
          projectKey,
          taskKey,
          actor,
          type: 'attachment_added',
          data: { attachmentId: ref.id, fileName: record.fileName, size, mediaType },
        });
        this.ctx.bus.publish({ type: 'task_attachments_changed', projectKey, taskKey });
        return toDto(record);
      });
    } catch (err) {
      await this.abandon(ref, writer, published);
      throw err;
    }
  }

  async open(projectKey: string, taskKey: string, id: string, actor: Actor): Promise<AttachmentContent> {
    await this.authorize(projectKey, taskKey, actor);
    const record = this.find(projectKey, taskKey, id, ['ready']);
    let stream: Readable;
    try {
      stream = await this.storage.openRead({ projectKey, taskKey, id }, record.size);
    } catch (err) {
      this.ctx.logger.error({ err, attachment: id }, 'attachment file could not be opened');
      throw storageFailed('the file could not be read');
    }
    return { attachment: toDto(record), stream };
  }

  async locate(projectKey: string, taskKey: string, id: string, actor: Actor): Promise<LocatedAttachment> {
    await this.authorize(projectKey, taskKey, actor);
    const record = this.find(projectKey, taskKey, id, ['ready']);
    try {
      const path = await this.storage.locate({ projectKey, taskKey, id }, record.size);
      return { attachment: toDto(record), path };
    } catch (err) {
      this.ctx.logger.error({ err, attachment: id }, 'attachment file could not be found');
      throw storageFailed('the file could not be read');
    }
  }

  async delete(projectKey: string, taskKey: string, id: string, actor: Actor): Promise<void> {
    const { viewer, task } = await this.authorize(projectKey, taskKey, actor);
    await this.deletions.run(id, async () => {
      const record = this.find(projectKey, taskKey, id, ['ready', 'deleting']);
      if (!canDeleteAttachment(viewer, task, record)) {
        throw forbidden('insufficient_access', 'only the uploader, an owner or an admin may delete this');
      }
      if (record.state === 'ready') {
        // Durable intent first. A deletion already under way (`deleting`) is finished as it was asked for.
        if (!this.ctx.repos.attachments.markDeleting(id, actor, isoNow(this.ctx)))
          throw notFound('attachment', id);
        await this.finishDeletion({ ...record, state: 'deleting', deletedBy: actor });
      } else {
        await this.finishDeletion(record);
      }
    });
  }

  /**
   * Startup: what the last run left half done. An upload that never completed is removed (file and
   * row, no event); a deletion under way is finished; temporary files nobody owns are removed.
   * Files that belong to no row are reported, not removed. Failures are logged and retried at the
   * next start; they never stop the server.
   */
  async recover(): Promise<void> {
    const { repos, logger } = this.ctx;
    for (const record of repos.attachments.inState('pending')) {
      try {
        await this.storage.remove(record);
        repos.attachments.remove(record.id);
        logger.info({ attachment: record.id }, 'removed an attachment upload that never completed');
      } catch (err) {
        logger.warn({ err, attachment: record.id }, 'could not remove an incomplete attachment upload');
      }
    }
    for (const record of repos.attachments.inState('deleting')) {
      try {
        await this.deletions.run(record.id, () => this.finishDeletion(record));
        logger.info({ attachment: record.id }, 'finished an attachment deletion');
      } catch (err) {
        logger.warn({ err, attachment: record.id }, 'could not finish an attachment deletion');
      }
    }
    try {
      const known = repos.attachments.ids();
      for (const file of await this.storage.scan()) {
        if (file.name.endsWith(TEMPORARY_SUFFIX)) {
          const id = file.name.slice(0, -TEMPORARY_SUFFIX.length);
          await this.storage
            .removeTemporary({ projectKey: file.projectKey, taskKey: file.taskKey, id })
            .catch((err: unknown) =>
              logger.warn({ err, file }, 'could not remove a temporary attachment file'),
            );
        } else if (!known.has(file.name)) {
          logger.warn({ file }, 'attachment storage holds a file that belongs to no attachment');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'could not scan the attachment storage');
    }
  }

  /** The acting member's current standing on the task; 404 for a task they may not see, as for an unknown one. */
  private async authorize(
    projectKey: string,
    taskKey: string,
    actor: Actor,
    need: 'read' | 'upload' = 'read',
  ): Promise<{ viewer: AttachmentViewer; task: Task }> {
    if (!this.projects.has(projectKey)) throw notFound('project', projectKey);
    const member =
      actor.kind === 'system' ? undefined : memberOf(await this.projects.config(projectKey), actor.handle);
    if (!member || member.kind !== actor.kind) {
      throw forbidden('not_a_member', 'only members of the project can use attachments');
    }
    const viewer: AttachmentViewer = {
      access: member.kind === 'human' ? member.access : 'ai',
      handle: member.handle,
    };
    const task = this.tasks.find(projectKey, taskKey);
    if (!task || !canReadAttachments(viewer, task)) throw notFound('task', taskKey);
    if (need === 'upload' && !canUploadAttachment(viewer, task)) {
      throw forbidden('insufficient_access', 'viewers cannot attach files');
    }
    return { viewer, task };
  }

  /** The row of this task's attachment in one of these states; 404 for any other. */
  private find(
    projectKey: string,
    taskKey: string,
    id: string,
    states: AttachmentRecord['state'][],
  ): AttachmentRecord {
    const record = this.ctx.repos.attachments.get(id);
    if (
      !record ||
      record.projectKey !== projectKey ||
      record.taskKey !== taskKey ||
      !states.includes(record.state)
    ) {
      throw notFound('attachment', id);
    }
    return record;
  }

  private async createWriter(ref: AttachmentRef): Promise<AttachmentWriter> {
    try {
      return await this.storage.create(ref);
    } catch (err) {
      this.ctx.logger.error({ err, attachment: ref.id }, 'attachment file could not be created');
      throw storageFailed('the file could not be stored');
    }
  }

  /** Streams the content into the writer, counting it against the limit. */
  private async receive(content: Readable, sink: Writable): Promise<{ size: number; head: Buffer }> {
    const meter = new UploadMeter();
    // A failing stream takes the others down with its error: the first one to report is the cause.
    let failed: { from: 'source' | 'sink'; err: unknown } | undefined;
    content.once('error', (err: unknown) => {
      failed ??= { from: 'source', err };
    });
    sink.once('error', (err: unknown) => {
      failed ??= { from: 'sink', err };
    });
    try {
      await pipeline(content, meter, sink);
    } catch (err) {
      if (meter.exceeded) {
        throw new DomainError(
          'attachment_too_large',
          `an attachment is at most ${MAX_ATTACHMENT_BYTES} bytes`,
          {
            status: 413,
            details: { maxBytes: MAX_ATTACHMENT_BYTES },
          },
        );
      }
      if (failed?.from === 'sink') {
        this.ctx.logger.error({ err: failed.err }, 'attachment content could not be written');
        throw storageFailed('the file could not be stored');
      }
      throw invalid('invalid_request', 'the upload was interrupted');
    }
    return { size: meter.size, head: meter.head };
  }

  /** Takes back a failed upload: the file (temporary or published) and the row. A leftover is recovered at the next start. */
  private async abandon(
    ref: AttachmentRef,
    writer: AttachmentWriter | undefined,
    published: boolean,
  ): Promise<void> {
    try {
      await writer?.discard();
      if (published) await this.storage.remove(ref);
      this.ctx.repos.attachments.remove(ref.id);
    } catch (err) {
      this.ctx.logger.warn({ err, attachment: ref.id }, 'could not clean up a failed attachment upload');
    }
  }

  /** The rest of a deletion: the file, then the row and the audit event together. */
  private async finishDeletion(record: AttachmentRecord): Promise<void> {
    try {
      await this.storage.remove(record);
    } catch (err) {
      this.ctx.logger.error({ err, attachment: record.id }, 'attachment file could not be removed');
      throw storageFailed('the file could not be removed; try again');
    }
    this.ctx.unitOfWork(() => {
      // Gone already: another call or a recovery finished it, with its own event.
      if (!this.ctx.repos.attachments.remove(record.id)) return;
      this.timeline.append({
        projectKey: record.projectKey,
        taskKey: record.taskKey,
        actor: record.deletedBy ?? SYSTEM_ACTOR,
        type: 'attachment_deleted',
        data: {
          attachmentId: record.id,
          fileName: record.fileName,
          size: record.size,
          mediaType: record.mediaType,
        },
      });
      this.ctx.bus.publish({
        type: 'task_attachments_changed',
        projectKey: record.projectKey,
        taskKey: record.taskKey,
      });
    });
  }
}

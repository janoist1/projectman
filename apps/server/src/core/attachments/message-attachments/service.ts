import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  MAX_MESSAGE_ATTACHMENTS,
  MAX_UNSENT_MESSAGE_ATTACHMENTS,
  attachmentPreviewOf,
  canDeleteMessageAttachment,
  canSeeTeamMessage,
  canSeeTask,
  memberOf,
} from '@projectman/shared';
import type {
  Actor,
  MessageAttachment,
  MessageAttachmentRef,
  TaskViewer,
  TeamMessage,
} from '@projectman/shared';
import type {
  AttachmentThumbnail,
  AttachmentWriter,
  MessageAttachmentContent,
  MessageAttachmentFileRef,
  MessageAttachmentOperations,
  MessageAttachmentReading,
  MessageAttachmentStorage,
  MessageAttachmentUploadInput,
} from '../../../contracts';
import type { MessageAttachmentRecord, MessageAttachmentState } from '../../../db';
import { sanitizeFileName } from '../attachments/file-name';
import { sniffMediaType } from '../attachments/media-type';
import { ThumbnailMaker } from '../attachments/thumbnail';
import { receiveUpload, storageFailed } from '../attachments/upload';
import { isoNow } from '../../base';
import type { DomainContext } from '../../base';
import { DomainError, forbidden, invalid, notFound } from '../../../kernel';
import type { ProjectService } from '../../projects';
import { KeyedMutex, SYSTEM_ACTOR, newId } from '../../../kernel';
import { MessageImageRenderer } from './image';
import { messageFileOwner } from './storage';

/** A text file this small (bytes) is handed to an AI member as text. */
export const MESSAGE_TEXT_MAX_BYTES = 100_000;

/** An upload no message took within this long is deleted by the sweep. */
export const UNSENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const FILE_NAME_MAX_BYTES = 255;

/**
 * The name a message attachment has in a session's folder (PM-518): `<id>-<file name>`, so two files
 * of the same name stay apart, at most 255 bytes (the extension is kept), and no path separator.
 */
export function sessionFileName(id: string, fileName: string): string {
  const prefix = `${id}-`;
  const room = FILE_NAME_MAX_BYTES - Buffer.byteLength(prefix);
  const name = fileName.replace(/[\\/\0]/g, '_');
  if (Buffer.byteLength(name) <= room) return `${prefix}${name}`;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && Buffer.byteLength(name.slice(dot)) <= 32 ? name.slice(dot) : '';
  let stem = '';
  let bytes = Buffer.byteLength(extension);
  for (const char of extension ? name.slice(0, dot) : name) {
    bytes += Buffer.byteLength(char);
    if (bytes > room) break;
    stem += char;
  }
  return `${prefix}${stem}${extension}`;
}

const toDto = (r: MessageAttachmentRecord): MessageAttachment => ({
  id: r.id,
  projectKey: r.projectKey,
  fileName: r.fileName,
  size: r.size,
  mediaType: r.mediaType,
  preview: r.preview,
  uploadedBy: r.uploadedBy,
  createdAt: r.createdAt,
  ...(r.messageId ? { messageId: r.messageId } : {}),
});

const toRef = (r: MessageAttachmentRecord): MessageAttachmentRef => ({
  id: r.id,
  fileName: r.fileName,
  size: r.size,
  mediaType: r.mediaType,
  preview: r.preview,
});

const unavailable = (id: string) =>
  new DomainError('message_attachment_unavailable', `message attachment ${id} cannot be sent`, {
    status: 409,
    details: { id },
  });

const sameUploader = (viewer: Pick<TaskViewer, 'access' | 'handle'>, uploader: Actor): boolean =>
  uploader.kind === (viewer.access === 'ai' ? 'ai' : 'human') && uploader.handle === viewer.handle;

/**
 * Files attached to team messages (PM-515, PM-516). The same discipline as the card attachments:
 * the file system and SQLite share no transaction, so the order of the steps and the durable state
 * of the row (`pending`, `ready`, `deleting`) carry the guarantees.
 *
 * - An upload is a `pending` row and a temporary file; the row turns `ready` once the whole stream
 *   was counted against the limit and the access checked again. A crash leaves a row `recover` removes.
 * - A file is the uploader's alone until a message takes it (`bindForSend`, inside the message's own
 *   unit of work); then whoever may see the message may open it.
 * - A deletion records the intent (`deleting`), removes the file, and only then removes the row and
 *   marks the message's entry gone, in one unit of work. The message keeps the entry (`goneAt`).
 * - An upload no message took within 24 hours is swept.
 */
export class MessageAttachmentService implements MessageAttachmentOperations {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly storage: MessageAttachmentStorage;
  private readonly deletions = new KeyedMutex();
  private readonly thumbnails: ThumbnailMaker<MessageAttachmentFileRef>;
  private readonly images = new MessageImageRenderer();

  constructor(deps: { ctx: DomainContext; projects: ProjectService; storage: MessageAttachmentStorage }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.storage = deps.storage;
    this.thumbnails = new ThumbnailMaker(deps.storage, (err, attachment) =>
      this.ctx.logger.warn({ err, attachment }, 'message attachment thumbnail could not be made'),
    );
  }

  async assertCanUpload(projectKey: string, actor: Actor): Promise<void> {
    await this.authorize(projectKey, actor);
    this.assertRoomFor(projectKey, actor);
  }

  async upload(input: MessageAttachmentUploadInput): Promise<MessageAttachment> {
    const { projectKey, actor } = input;
    await this.authorize(projectKey, actor);
    const { repos } = this.ctx;
    const ref: MessageAttachmentFileRef = { projectKey, id: newId('msa') };
    // Counting and inserting are one synchronous step: parallel uploads cannot pass the limit together.
    this.assertRoomFor(projectKey, actor);
    repos.messageAttachments.insertPending({
      id: ref.id,
      projectKey,
      fileName: sanitizeFileName(input.fileName),
      uploadedBy: actor,
      createdAt: isoNow(this.ctx),
    });
    let writer: AttachmentWriter | undefined;
    let published = false;
    try {
      writer = await this.createWriter(ref);
      const { size, head } = await receiveUpload(input.content, writer.stream, (err) =>
        this.ctx.logger.error({ err }, 'message attachment content could not be written'),
      );
      // The access may have changed while the bytes arrived (membership).
      await this.authorize(projectKey, actor);
      await input.beforeCommit?.();
      await writer.publish().catch((err: unknown) => {
        this.ctx.logger.error({ err, attachment: ref.id }, 'message attachment could not be published');
        throw storageFailed('the file could not be stored');
      });
      published = true;
      const mediaType = sniffMediaType(head);
      return this.ctx.unitOfWork(() => {
        if (
          !repos.messageAttachments.markReady(ref.id, {
            size,
            mediaType,
            preview: attachmentPreviewOf(mediaType),
          })
        )
          throw new Error('message attachment row vanished');
        return toDto(repos.messageAttachments.get(ref.id)!);
      });
    } catch (err) {
      await this.abandon(ref, writer, published);
      throw err;
    }
  }

  async open(projectKey: string, id: string, actor: Actor): Promise<MessageAttachmentContent> {
    const viewer = await this.authorize(projectKey, actor);
    const record = this.find(projectKey, id, viewer, ['ready']);
    return { attachment: toDto(record), stream: await this.openFile(record) };
  }

  async thumbnail(projectKey: string, id: string, actor: Actor): Promise<AttachmentThumbnail> {
    const viewer = await this.authorize(projectKey, actor);
    const record = this.find(projectKey, id, viewer, ['ready']);
    // Only an image proven from its content; never a PDF, never SVG.
    if (record.preview !== 'image') throw notFound('message attachment thumbnail', id);
    const ref: MessageAttachmentFileRef = { projectKey, id };
    try {
      const existing = await this.storage.openThumbnail(ref);
      if (existing) return existing;
    } catch (err) {
      this.ctx.logger.error({ err, attachment: id }, 'message attachment thumbnail could not be opened');
      throw storageFailed('the thumbnail could not be read');
    }
    if (!(await this.thumbnails.make(ref, record.size))) throw notFound('message attachment thumbnail', id);
    // A deletion that came meanwhile removed the files before the thumbnail was stored.
    if (this.ctx.repos.messageAttachments.get(id)?.state !== 'ready') {
      await this.storage.remove(ref).catch(() => undefined);
      throw notFound('message attachment', id);
    }
    try {
      const made = await this.storage.openThumbnail(ref);
      if (made) return made;
    } catch (err) {
      this.ctx.logger.error({ err, attachment: id }, 'message attachment thumbnail could not be opened');
      throw storageFailed('the thumbnail could not be read');
    }
    throw notFound('message attachment thumbnail', id);
  }

  async delete(projectKey: string, id: string, actor: Actor): Promise<void> {
    const viewer = await this.authorize(projectKey, actor);
    await this.deletions.run(id, async () => {
      const record = this.find(projectKey, id, viewer, ['ready', 'deleting']);
      if (!canDeleteMessageAttachment(viewer, record)) {
        throw forbidden('insufficient_access', 'only the uploader, an owner or an admin may delete this');
      }
      if (record.state === 'ready') {
        // Durable intent first. A deletion already under way (`deleting`) is finished as it was asked for.
        if (!this.ctx.repos.messageAttachments.markDeleting(id, actor, isoNow(this.ctx)))
          throw notFound('message attachment', id);
        await this.finishDeletion({ ...record, state: 'deleting', deletedBy: actor });
      } else {
        await this.finishDeletion(record);
      }
    });
  }

  /**
   * Refuses unless every id is a ready file nobody has sent yet, of this project, uploaded by the
   * sender (409 `message_attachment_unavailable`, `details.id`). `Messaging` calls it before it does
   * anything else for the message, so a refusal leaves nothing behind.
   */
  assertSendable(projectKey: string, sender: Actor, ids: readonly string[]): void {
    this.sendable(projectKey, sender, ids);
  }

  /**
   * Gives the files to the message `messageId`: the same checks as `assertSendable`, then the binding.
   * Runs inside the message's unit of work, so a refusal takes nothing with it. Returns the entries the
   * message carries, in the order of `ids`.
   */
  bindForSend(
    projectKey: string,
    sender: Actor,
    ids: readonly string[],
    messageId: string,
  ): MessageAttachmentRef[] {
    const records = this.sendable(projectKey, sender, ids);
    const at = isoNow(this.ctx);
    for (const record of records) {
      if (!this.ctx.repos.messageAttachments.bind(record.id, messageId, at)) throw unavailable(record.id);
    }
    return records.map(toRef);
  }

  /** Internal to the atomic human fanout; ordinary sends still require unsent uploads. */
  shareForQuestionGroupAnswer(
    projectKey: string,
    primaryItemId: string,
    itemId: string,
    attachmentIds: readonly string[],
  ): MessageAttachmentRef[] {
    const { repos } = this.ctx;
    const target = repos.inbox.get(itemId);
    if (
      !target ||
      target.projectKey !== projectKey ||
      repos.inbox.groupOf(itemId)?.primaryItemId !== primaryItemId ||
      target.payload.groupWithdrawn === true ||
      target.state !== 'resolved' ||
      !target.resolution ||
      target.resolution.rule ||
      memberOf(this.projects.cachedConfig(projectKey)!, target.source)?.kind !== 'ai' ||
      (target.taskKey && !repos.tasks.get(target.taskKey))
    )
      throw unavailable(attachmentIds[0] ?? '');
    return attachmentIds.map((id) => {
      const record = repos.messageAttachments.get(id);
      const anchor = record?.messageId ? repos.messages.get(record.messageId) : null;
      if (
        !record ||
        record.projectKey !== projectKey ||
        record.state !== 'ready' ||
        !anchor ||
        anchor.projectKey !== projectKey ||
        anchor.origin?.kind !== 'answer' ||
        repos.inbox.groupOf(anchor.origin.inboxItemId)?.primaryItemId !== primaryItemId ||
        !anchor.attachments?.some((file) => file.id === id && !file.goneAt) ||
        anchor.from !== target.resolution!.by ||
        anchor.via !== target.resolution!.via ||
        memberOf(this.projects.cachedConfig(projectKey)!, anchor.from)?.kind !== 'human'
      )
        throw unavailable(id);
      return toRef(record);
    });
  }

  /**
   * The content of a file of a team message for an AI member (`read_message_attachment`), judged
   * through `viewer`'s eyes: a file of a message they cannot see is not found, whoever uploaded it.
   */
  async reading(
    projectKey: string,
    id: string,
    viewer: TaskViewer,
    options: { images?: boolean } = {},
  ): Promise<MessageAttachmentReading> {
    const { record, message } = this.visibleTo(projectKey, id, viewer);
    const reading = (content: MessageAttachmentReading['content']): MessageAttachmentReading => ({
      attachment: toRef(record),
      message: { id: message.id, from: message.from, createdAt: message.createdAt },
      content,
    });
    // The caller's CLI does not show images in a tool result (PM-518): the file is all it gets.
    if (record.preview === 'image' && options.images === false)
      return reading({ kind: 'none', reason: 'type' });
    if (record.preview === 'image') {
      const bytes = await this.readWhole(record);
      try {
        const webp = await this.images.render(bytes);
        return reading(
          webp
            ? { kind: 'image', data: webp, mimeType: 'image/webp' }
            : { kind: 'none', reason: 'too_large' },
        );
      } catch (err) {
        // The type was proven from the first bytes only: a broken or oversized image is not shown.
        this.ctx.logger.warn({ err, attachment: id }, 'message attachment image could not be rendered');
        return reading({ kind: 'none', reason: 'type' });
      }
    }
    if (record.preview !== 'none' || record.size > MESSAGE_TEXT_MAX_BYTES)
      return reading({ kind: 'none', reason: 'type' });
    const bytes = await this.readWhole(record);
    if (bytes.includes(0)) return reading({ kind: 'none', reason: 'type' });
    try {
      return reading({ kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
    } catch {
      return reading({ kind: 'none', reason: 'type' });
    }
  }

  /**
   * The stored file of a message attachment `viewer` may see, for giving it to a session's engine
   * (PM-518): its absolute path on this machine with the size and SHA-256 the engine checks. Not found
   * exactly as `reading` is.
   */
  async source(
    projectKey: string,
    id: string,
    viewer: TaskViewer,
  ): Promise<{ path: string; size: number; sha256: string }> {
    const { record } = this.visibleTo(projectKey, id, viewer);
    try {
      const path = await this.storage.locate({ projectKey, id }, record.size);
      const hash = createHash('sha256');
      const stream = await this.openFile(record);
      try {
        for await (const chunk of stream) hash.update(chunk as Buffer);
      } finally {
        stream.destroy();
      }
      return { path, size: record.size, sha256: hash.digest('hex') };
    } catch (err) {
      this.ctx.logger.error({ err, attachment: id }, 'message attachment file could not be located');
      throw storageFailed('the file could not be read');
    }
  }

  /** The ready, sent file and its message, when `viewer` sees the message; otherwise not found. */
  private visibleTo(
    projectKey: string,
    id: string,
    viewer: TaskViewer,
  ): { record: MessageAttachmentRecord; message: TeamMessage } {
    const { repos } = this.ctx;
    const record = repos.messageAttachments.get(id);
    const message = record ? this.visibleCarrier(projectKey, record, viewer) : null;
    if (!record || record.projectKey !== projectKey || record.state !== 'ready' || !message)
      throw notFound('message attachment', id);
    return { record, message };
  }

  /** A visible message, never metadata from an anchor hidden from this viewer. */
  private visibleCarrier(
    projectKey: string,
    record: MessageAttachmentRecord,
    viewer: TaskViewer,
  ): TeamMessage | null {
    const { repos } = this.ctx;
    const anchor = record.messageId ? repos.messages.get(record.messageId) : null;
    if (!anchor || anchor.projectKey !== projectKey) return null;
    if (!anchor.attachments?.some((file) => file.id === record.id && !file.goneAt)) return null;
    if (canSeeTeamMessage(viewer, anchor)) return anchor;
    if (anchor.origin?.kind !== 'answer') return null;
    const group = repos.inbox.groupOf(anchor.origin.inboxItemId);
    if (!group || !anchor.attachments?.some((file) => file.id === record.id && !file.goneAt)) return null;
    return (
      repos.messages.listByAttachment(projectKey, record.id).find((message) => {
        if (
          message.origin?.kind !== 'answer' ||
          !canSeeTeamMessage(viewer, message) ||
          message.from !== anchor.from ||
          message.via !== anchor.via ||
          repos.inbox.groupOf(message.origin.inboxItemId)?.primaryItemId !== group.primaryItemId ||
          !message.attachments?.some((file) => file.id === record.id && !file.goneAt)
        )
          return false;
        const target = repos.inbox.get(message.origin.inboxItemId);
        const task = target?.taskKey ? repos.tasks.get(target.taskKey) : null;
        return (
          !!target &&
          target.payload.groupWithdrawn !== true &&
          target.state === 'resolved' &&
          target.resolution?.by === anchor.from &&
          target.resolution.via === anchor.via &&
          message.to.includes(target.source) &&
          (!target.taskKey || (!!task && canSeeTask(viewer, task)))
        );
      }) ?? null
    );
  }

  /**
   * Startup: what the last run left half done. An upload that never completed is removed (file and
   * row); a deletion under way is finished; temporary files nobody owns are removed. Files that
   * belong to no row are reported, not removed. Failures are logged and retried at the next start.
   */
  async recover(): Promise<void> {
    const { repos, logger } = this.ctx;
    for (const record of repos.messageAttachments.inState('pending')) {
      try {
        await this.storage.remove(record);
        repos.messageAttachments.remove(record.id);
        logger.info({ attachment: record.id }, 'removed a message attachment upload that never completed');
      } catch (err) {
        logger.warn(
          { err, attachment: record.id },
          'could not remove an incomplete message attachment upload',
        );
      }
    }
    for (const record of repos.messageAttachments.inState('deleting')) {
      try {
        await this.deletions.run(record.id, () => this.finishDeletion(record));
        logger.info({ attachment: record.id }, 'finished a message attachment deletion');
      } catch (err) {
        logger.warn({ err, attachment: record.id }, 'could not finish a message attachment deletion');
      }
    }
    try {
      const known = repos.messageAttachments.ids();
      for (const file of await this.storage.scan()) {
        const id = messageFileOwner(file.name);
        if (id === null) continue;
        const ref = { projectKey: file.projectKey, id };
        if (file.name.endsWith('.part')) {
          await this.storage
            .removeTemporary(ref)
            .catch((err: unknown) => logger.warn({ err, file }, 'could not remove a temporary message file'));
        } else if (!known.has(id)) {
          // A thumbnail goes with its file; a file without a row is reported, not removed.
          if (file.name.endsWith('.thumb'))
            await this.storage
              .remove(ref)
              .catch((err: unknown) => logger.warn({ err, file }, 'could not remove a message thumbnail'));
          else logger.warn({ file }, 'message attachment storage holds a file that belongs to no attachment');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'could not scan the message attachment storage');
    }
  }

  /** Deletes the uploads no message took within 24 hours; returns how many went. Failures are logged. */
  async sweepUnsent(): Promise<number> {
    const { repos, logger } = this.ctx;
    const cutoff = new Date(this.ctx.now().getTime() - UNSENT_MAX_AGE_MS).toISOString();
    let swept = 0;
    for (const record of repos.messageAttachments.unsentBefore(cutoff)) {
      try {
        await this.deletions.run(record.id, async () => {
          const current = repos.messageAttachments.get(record.id);
          // Sent, or deleted by its uploader, since the list was read.
          if (current?.state !== 'ready' || current.messageId) return;
          if (!repos.messageAttachments.markDeleting(record.id, SYSTEM_ACTOR, isoNow(this.ctx))) return;
          await this.finishDeletion({ ...current, state: 'deleting', deletedBy: SYSTEM_ACTOR });
          swept += 1;
        });
      } catch (err) {
        logger.warn({ err, attachment: record.id }, 'could not sweep an unsent message attachment');
      }
    }
    return swept;
  }

  /** Sweeps now and then hourly; returns the function that stops it. */
  startSweeping(): () => void {
    const run = () =>
      void this.sweepUnsent().catch((err: unknown) =>
        this.ctx.logger.warn({ err }, 'the sweep of unsent message attachments failed'),
      );
    run();
    const timer = setInterval(run, SWEEP_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** The acting member's current standing in the project; every member may upload for a message they can send. */
  private async authorize(projectKey: string, actor: Actor): Promise<TaskViewer> {
    if (!this.projects.has(projectKey)) throw notFound('project', projectKey);
    const member =
      actor.kind === 'system' ? undefined : memberOf(await this.projects.config(projectKey), actor.handle);
    if (!member || member.kind !== actor.kind) {
      throw forbidden('not_a_member', 'only members of the project can use message attachments');
    }
    return { access: member.kind === 'human' ? member.access : 'ai', handle: member.handle };
  }

  private assertRoomFor(projectKey: string, actor: Actor): void {
    if (
      this.ctx.repos.messageAttachments.unsentOf(projectKey, actor).length >= MAX_UNSENT_MESSAGE_ATTACHMENTS
    ) {
      throw new DomainError(
        'message_attachment_limit',
        `at most ${MAX_UNSENT_MESSAGE_ATTACHMENTS} unsent files per member; send or delete some first`,
        { status: 409, details: { max: MAX_UNSENT_MESSAGE_ATTACHMENTS } },
      );
    }
  }

  /**
   * The row of a file the viewer may see, in one of these states; 404 for any other, an invisible
   * file included. A sent file is the message's: whoever may see the message. An unsent one is its
   * uploader's alone.
   */
  private find(
    projectKey: string,
    id: string,
    viewer: TaskViewer,
    states: MessageAttachmentState[],
  ): MessageAttachmentRecord {
    const record = this.ctx.repos.messageAttachments.get(id);
    if (!record || record.projectKey !== projectKey || !states.includes(record.state)) {
      throw notFound('message attachment', id);
    }
    const carrier = record.messageId ? this.visibleCarrier(projectKey, record, viewer) : null;
    const visible = record.messageId ? !!carrier : sameUploader(viewer, record.uploadedBy);
    if (!visible) throw notFound('message attachment', id);
    return carrier ? { ...record, messageId: carrier.id } : record;
  }

  /** The files `ids` name, after checking each is the sender's own ready, unsent file of this project. */
  private sendable(projectKey: string, sender: Actor, ids: readonly string[]): MessageAttachmentRecord[] {
    const unique = [...new Set(ids)];
    if (unique.length > MAX_MESSAGE_ATTACHMENTS)
      throw invalid('invalid_request', `a message carries at most ${MAX_MESSAGE_ATTACHMENTS} files`, {
        field: 'attachmentIds',
      });
    return unique.map((id) => {
      const record = this.ctx.repos.messageAttachments.get(id);
      if (
        !record ||
        record.projectKey !== projectKey ||
        record.state !== 'ready' ||
        record.messageId ||
        record.uploadedBy.kind !== sender.kind ||
        record.uploadedBy.handle !== sender.handle
      ) {
        throw unavailable(id);
      }
      return record;
    });
  }

  private async openFile(record: MessageAttachmentRecord): Promise<Readable> {
    try {
      return await this.storage.openRead(record, record.size);
    } catch (err) {
      this.ctx.logger.error({ err, attachment: record.id }, 'message attachment file could not be opened');
      throw storageFailed('the file could not be read');
    }
  }

  /** The whole file in memory; it is at most the upload limit. */
  private async readWhole(record: MessageAttachmentRecord): Promise<Buffer> {
    const stream = await this.openFile(record);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    } catch (err) {
      this.ctx.logger.error({ err, attachment: record.id }, 'message attachment file could not be read');
      throw storageFailed('the file could not be read');
    } finally {
      stream.destroy();
    }
  }

  private async createWriter(ref: MessageAttachmentFileRef): Promise<AttachmentWriter> {
    try {
      return await this.storage.create(ref);
    } catch (err) {
      this.ctx.logger.error({ err, attachment: ref.id }, 'message attachment file could not be created');
      throw storageFailed('the file could not be stored');
    }
  }

  /** Takes back a failed upload: the file (temporary or published) and the row. A leftover is recovered at the next start. */
  private async abandon(
    ref: MessageAttachmentFileRef,
    writer: AttachmentWriter | undefined,
    published: boolean,
  ): Promise<void> {
    try {
      await writer?.discard();
      if (published) await this.storage.remove(ref);
      this.ctx.repos.messageAttachments.remove(ref.id);
    } catch (err) {
      this.ctx.logger.warn(
        { err, attachment: ref.id },
        'could not clean up a failed message attachment upload',
      );
    }
  }

  /** The rest of a deletion: the file, then the row and the message's entry together. */
  private async finishDeletion(record: MessageAttachmentRecord): Promise<void> {
    try {
      await this.storage.remove(record);
    } catch (err) {
      this.ctx.logger.error({ err, attachment: record.id }, 'message attachment file could not be removed');
      throw storageFailed('the file could not be removed; try again');
    }
    this.thumbnails.forget(record.id);
    this.ctx.unitOfWork(() => {
      const { repos } = this.ctx;
      // Gone already: another call or a recovery finished it.
      if (!repos.messageAttachments.remove(record.id)) return;
      if (!record.messageId) return;
      for (const carrier of repos.messages.listByAttachment(record.projectKey, record.id)) {
        const message = repos.messages.markAttachmentGone(
          carrier.id,
          record.id,
          isoNow(this.ctx),
          record.deletedBy ?? SYSTEM_ACTOR,
        );
        // The message changed but is not a new one: the live event carries it, the timeline gets no entry.
        if (message)
          this.ctx.bus.publish({ type: 'team_message_updated', projectKey: record.projectKey, message });
      }
    });
  }
}

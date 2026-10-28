import type { Actor, AttachmentPreview, MessageAttachment } from '@projectman/shared';
import type { Db } from './database';

/** Where a message's file is in its life; only `ready` ones are readable. */
export type MessageAttachmentState = 'pending' | 'ready' | 'deleting';

/** A message attachment row: the web's DTO plus the durable operation state. */
export interface MessageAttachmentRecord extends MessageAttachment {
  state: MessageAttachmentState;
  /** When a message took the file. */
  boundAt: string | null;
  /** Who asked to delete it, once the intent is recorded (state `deleting`). */
  deletedBy: Actor | null;
  deleteRequestedAt: string | null;
}

interface MessageAttachmentRow {
  id: string;
  project_key: string;
  message_id: string | null;
  file_name: string;
  size: number;
  media_type: string;
  preview: string;
  uploaded_by_kind: string;
  uploaded_by_handle: string;
  created_at: string;
  bound_at: string | null;
  state: string;
  deleted_by_kind: string | null;
  deleted_by_handle: string | null;
  delete_requested_at: string | null;
}

const toActor = (kind: string, handle: string | null): Actor => ({ kind: kind as Actor['kind'], handle });

const toRecord = (r: MessageAttachmentRow): MessageAttachmentRecord => ({
  id: r.id,
  projectKey: r.project_key,
  fileName: r.file_name,
  size: r.size,
  mediaType: r.media_type,
  preview: r.preview as AttachmentPreview,
  uploadedBy: toActor(r.uploaded_by_kind, r.uploaded_by_handle),
  createdAt: r.created_at,
  ...(r.message_id ? { messageId: r.message_id } : {}),
  state: r.state as MessageAttachmentState,
  boundAt: r.bound_at,
  deletedBy: r.deleted_by_kind ? toActor(r.deleted_by_kind, r.deleted_by_handle) : null,
  deleteRequestedAt: r.delete_requested_at,
});

/** The metadata that is known only once the file is stored. */
interface StoredMessageAttachment {
  size: number;
  mediaType: string;
  preview: AttachmentPreview;
}

export function createMessageAttachmentRepository(db: Db) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO message_attachments (id, project_key, file_name, size, media_type, preview,
         uploaded_by_kind, uploaded_by_handle, created_at, state)
       VALUES (?, ?, ?, 0, 'application/octet-stream', 'none', ?, ?, ?, 'pending')`,
    ),
    get: db.prepare('SELECT * FROM message_attachments WHERE id = ?'),
    ready: db.prepare(
      `UPDATE message_attachments SET state = 'ready', size = ?, media_type = ?, preview = ?
       WHERE id = ? AND state = 'pending'`,
    ),
    bind: db.prepare(
      `UPDATE message_attachments SET message_id = ?, bound_at = ?
       WHERE id = ? AND state = 'ready' AND message_id IS NULL`,
    ),
    markDeleting: db.prepare(
      `UPDATE message_attachments SET state = 'deleting', deleted_by_kind = ?, deleted_by_handle = ?, delete_requested_at = ?
       WHERE id = ? AND state = 'ready'`,
    ),
    remove: db.prepare('DELETE FROM message_attachments WHERE id = ?'),
    unsentOf: db.prepare(
      `SELECT * FROM message_attachments WHERE project_key = ? AND uploaded_by_kind = ? AND uploaded_by_handle = ?
       AND message_id IS NULL AND state IN ('pending', 'ready') ORDER BY seq`,
    ),
    unsentBefore: db.prepare(
      `SELECT * FROM message_attachments WHERE state = 'ready' AND message_id IS NULL AND created_at < ? ORDER BY seq`,
    ),
    inState: db.prepare('SELECT * FROM message_attachments WHERE state = ? ORDER BY seq'),
    all: db.prepare('SELECT id FROM message_attachments'),
  };
  const first = (row: unknown): MessageAttachmentRecord | null =>
    row ? toRecord(row as MessageAttachmentRow) : null;

  return {
    /** A new row in state `pending`: the upload is about to be written. */
    insertPending(
      a: Pick<MessageAttachment, 'id' | 'projectKey' | 'fileName' | 'uploadedBy' | 'createdAt'>,
    ): void {
      statements.insert.run(
        a.id,
        a.projectKey,
        a.fileName,
        a.uploadedBy.kind,
        a.uploadedBy.handle,
        a.createdAt,
      );
    },
    get(id: string): MessageAttachmentRecord | null {
      return first(statements.get.get(id));
    },
    /** `pending` to `ready` with what the stored file turned out to be; false when it was not pending. */
    markReady(id: string, stored: StoredMessageAttachment): boolean {
      return statements.ready.run(stored.size, stored.mediaType, stored.preview, id).changes > 0;
    },
    /** A ready, unsent file becomes the message's; false when it was not (ready, unsent). */
    bind(id: string, messageId: string, at: string): boolean {
      return statements.bind.run(messageId, at, id).changes > 0;
    },
    /** `ready` to `deleting`: the durable intent, with who asked; false when it was not ready. */
    markDeleting(id: string, by: Actor, at: string): boolean {
      return statements.markDeleting.run(by.kind, by.handle, at, id).changes > 0;
    },
    /** Removes the row (a finished deletion, or an upload that never completed); false when there was none. */
    remove(id: string): boolean {
      return statements.remove.run(id).changes > 0;
    },
    /** The files the member uploaded that no message took yet (those still being written too), oldest first. */
    unsentOf(projectKey: string, uploader: Actor): MessageAttachmentRecord[] {
      return (
        statements.unsentOf.all(projectKey, uploader.kind, uploader.handle) as MessageAttachmentRow[]
      ).map(toRecord);
    },
    /** Ready files no message took, uploaded before the time (ISO), oldest first. */
    unsentBefore(time: string): MessageAttachmentRecord[] {
      return (statements.unsentBefore.all(time) as MessageAttachmentRow[]).map(toRecord);
    },
    inState(state: MessageAttachmentState): MessageAttachmentRecord[] {
      return (statements.inState.all(state) as MessageAttachmentRow[]).map(toRecord);
    },
    /** Every stored id, whatever its state. */
    ids(): Set<string> {
      return new Set((statements.all.all() as Array<{ id: string }>).map((r) => r.id));
    },
  };
}

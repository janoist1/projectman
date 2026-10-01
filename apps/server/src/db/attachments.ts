import type { Actor, Attachment, AttachmentPreview } from '@projectman/shared';
import type { Db } from './database';

/** Where an attachment is in its life; only `ready` ones are readable. */
export type AttachmentState = 'pending' | 'ready' | 'deleting';

/** An attachment row: the web's DTO plus the durable operation state. */
export interface AttachmentRecord extends Attachment {
  state: AttachmentState;
  /** Who asked to delete it, once the intent is recorded (state `deleting`). */
  deletedBy: Actor | null;
  deleteRequestedAt: string | null;
}

interface AttachmentRow {
  id: string;
  project_key: string;
  task_key: string;
  file_name: string;
  size: number;
  media_type: string;
  preview: string;
  uploaded_by_kind: string;
  uploaded_by_handle: string | null;
  created_at: string;
  state: string;
  deleted_by_kind: string | null;
  deleted_by_handle: string | null;
  delete_requested_at: string | null;
}

const toActor = (kind: string, handle: string | null): Actor => ({ kind: kind as Actor['kind'], handle });

const toRecord = (r: AttachmentRow): AttachmentRecord => ({
  id: r.id,
  projectKey: r.project_key,
  taskKey: r.task_key,
  fileName: r.file_name,
  size: r.size,
  mediaType: r.media_type,
  preview: r.preview as AttachmentPreview,
  uploadedBy: toActor(r.uploaded_by_kind, r.uploaded_by_handle),
  createdAt: r.created_at,
  state: r.state as AttachmentState,
  deletedBy: r.deleted_by_kind ? toActor(r.deleted_by_kind, r.deleted_by_handle) : null,
  deleteRequestedAt: r.delete_requested_at,
});

/** The metadata that is known only once the file is stored. */
export interface StoredAttachment {
  size: number;
  mediaType: string;
  preview: AttachmentPreview;
}

export function createAttachmentRepository(db: Db) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO attachments (id, project_key, task_key, file_name, size, media_type, preview,
         uploaded_by_kind, uploaded_by_handle, created_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ),
    get: db.prepare('SELECT * FROM attachments WHERE id = ?'),
    ready: db.prepare(
      `UPDATE attachments SET state = 'ready', size = ?, media_type = ?, preview = ?
       WHERE id = ? AND state = 'pending'`,
    ),
    markDeleting: db.prepare(
      `UPDATE attachments SET state = 'deleting', deleted_by_kind = ?, deleted_by_handle = ?, delete_requested_at = ?
       WHERE id = ? AND state = 'ready'`,
    ),
    remove: db.prepare('DELETE FROM attachments WHERE id = ?'),
    listReady: db.prepare(
      `SELECT * FROM attachments WHERE project_key = ? AND task_key = ? AND state = 'ready' ORDER BY seq`,
    ),
    inState: db.prepare('SELECT * FROM attachments WHERE state = ? ORDER BY seq'),
    all: db.prepare('SELECT id FROM attachments'),
  };
  const first = (row: unknown): AttachmentRecord | null => (row ? toRecord(row as AttachmentRow) : null);

  return {
    /** A new row in state `pending`: the upload is about to be written. */
    insertPending(a: Omit<Attachment, 'size' | 'mediaType' | 'preview'>): void {
      statements.insert.run(
        a.id,
        a.projectKey,
        a.taskKey,
        a.fileName,
        0,
        'application/octet-stream',
        'none',
        a.uploadedBy.kind,
        a.uploadedBy.handle,
        a.createdAt,
      );
    },
    get(id: string): AttachmentRecord | null {
      return first(statements.get.get(id));
    },
    /** `pending` to `ready` with what the stored file turned out to be; false when it was not pending. */
    markReady(id: string, stored: StoredAttachment): boolean {
      return statements.ready.run(stored.size, stored.mediaType, stored.preview, id).changes > 0;
    },
    /** `ready` to `deleting`: the durable intent, with who asked; false when it was not ready. */
    markDeleting(id: string, by: Actor, at: string): boolean {
      return statements.markDeleting.run(by.kind, by.handle, at, id).changes > 0;
    },
    /** Removes the row (a finished deletion, or an upload that never completed); false when there was none. */
    remove(id: string): boolean {
      return statements.remove.run(id).changes > 0;
    },
    /** The readable attachments of a task, oldest first. */
    listReady(projectKey: string, taskKey: string): AttachmentRecord[] {
      return (statements.listReady.all(projectKey, taskKey) as AttachmentRow[]).map(toRecord);
    },
    inState(state: AttachmentState): AttachmentRecord[] {
      return (statements.inState.all(state) as AttachmentRow[]).map(toRecord);
    },
    /** Every stored id, whatever its state. */
    ids(): Set<string> {
      return new Set((statements.all.all() as Array<{ id: string }>).map((r) => r.id));
    },
  };
}

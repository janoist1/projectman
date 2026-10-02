import type { Readable, Writable } from 'node:stream';
import type { Actor, Attachment } from '@projectman/shared';

/**
 * The boundary between whoever receives a file (the REST route, the team tool `attach_file`) and the
 * attachments service: it takes a stream and applies one size, storage and access check, whoever
 * asks. Access is judged for the acting member against the current roster and task visibility.
 */
export interface AttachmentUploadInput {
  projectKey: string;
  taskKey: string;
  actor: Actor;
  /** The name the client gave; stored sanitised, only as metadata, never as a path. */
  fileName: string;
  /** The file's bytes; read once, never buffered whole. */
  content: Readable;
  /**
   * Checked after the content is fully stored and before it is published, on top of the access
   * check the service repeats there (for example the caller's login still being valid). Throws to refuse.
   */
  beforeCommit?: () => void | Promise<void>;
}

export interface AttachmentContent {
  attachment: Attachment;
  /** The stored bytes; `attachment.size` long. */
  stream: Readable;
}

export interface AttachmentOperations {
  /** The readable attachments of a task, oldest first. */
  list(projectKey: string, taskKey: string, actor: Actor): Promise<Attachment[]>;
  /** Refuses (as `upload` would at its start) unless the actor may upload to the task. */
  assertCanUpload(projectKey: string, taskKey: string, actor: Actor): Promise<void>;
  upload(input: AttachmentUploadInput): Promise<Attachment>;
  /** Opens a ready attachment of this task; the caller must close the stream. */
  open(projectKey: string, taskKey: string, id: string, actor: Actor): Promise<AttachmentContent>;
  /**
   * The small WebP preview of a ready image attachment (PM-195), made on the first request and
   * kept; the same access check as `open`. Not found for any other file and for an image that
   * cannot be decoded. The caller must close the stream.
   */
  thumbnail(projectKey: string, taskKey: string, id: string, actor: Actor): Promise<AttachmentThumbnail>;
  /**
   * Deletes the file and the metadata and writes the audit event; resolves only when all of it is
   * done. After a failure the attachment stays in its `deleting` state: it is not readable, and
   * the same call (or the next start of the server) finishes it, once.
   */
  delete(projectKey: string, taskKey: string, id: string, actor: Actor): Promise<void>;
  /**
   * Where a ready attachment of this task is stored, for an AI member that opens it with its own
   * tools (the team tool `read_attachment`): the same access check as `open`, and the file must be
   * the regular file of the recorded size.
   */
  locate(projectKey: string, taskKey: string, id: string, actor: Actor): Promise<LocatedAttachment>;
}

export interface AttachmentThumbnail {
  /** The stored WebP bytes; `size` long. */
  stream: Readable;
  size: number;
}

export interface LocatedAttachment {
  attachment: Attachment;
  /** Absolute path of the stored file, under the resolved storage root. */
  path: string;
}

/** Where an attachment lives in storage; the id names the file. */
export interface AttachmentRef {
  projectKey: string;
  taskKey: string;
  id: string;
}

/** A file being written under a temporary name. */
export interface AttachmentWriter {
  /** Receives the bytes. */
  stream: Writable;
  /** Makes the written file the attachment's file (flushed, atomically renamed into place). */
  publish(): Promise<void>;
  /** Drops what was written; safe to call after any failure. */
  discard(): Promise<void>;
}

/** A regular file found in storage by `scan`. */
export interface StoredFile {
  projectKey: string;
  taskKey: string;
  /** The file name in the task's directory: an id, or an id with the temporary suffix. */
  name: string;
}

/**
 * The files of attachments: private (mode 0700 directories, 0600 files), regular files only, no
 * symlink followed. The storage knows nothing of the database.
 */
export interface AttachmentStorage {
  create(ref: AttachmentRef): Promise<AttachmentWriter>;
  /** Opens the published file for reading; throws unless it is a regular file of `size` bytes. */
  openRead(ref: AttachmentRef, size: number): Promise<Readable>;
  /** A file being written as the attachment's thumbnail (`<id>.thumb`, under `<id>.thumb.part` meanwhile). */
  createThumbnail(ref: AttachmentRef): Promise<AttachmentWriter>;
  /** Opens the attachment's thumbnail; null when there is none (yet). A file that is not a regular one is an error. */
  openThumbnail(ref: AttachmentRef): Promise<AttachmentThumbnail | null>;
  /**
   * The published file's absolute path for an agent's own reader; throws unless it is a regular
   * file of `size` bytes. An image or PDF (`mediaType` as proven from the content) gets a path
   * with its extension, a second name of the same file that `remove` removes with it.
   */
  locate(ref: AttachmentRef, size: number, mediaType: string): Promise<string>;
  /**
   * The absolute directory that holds (or will hold) a task's attachments, under the resolved
   * storage root; nothing is created. What an AI session on the task may read.
   */
  taskDirectory(projectKey: string, taskKey: string): Promise<string>;
  /** Removes the published file, its thumbnail and any temporary one; a missing file is fine. */
  remove(ref: AttachmentRef): Promise<void>;
  /** Removes only the temporary files (of the attachment and of its thumbnail); a missing file is fine. */
  removeTemporary(ref: AttachmentRef): Promise<void>;
  /** Every regular file under the storage root (what recovery compares with the database). */
  scan(): Promise<StoredFile[]>;
}

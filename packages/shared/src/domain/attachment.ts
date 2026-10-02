import { z } from 'zod';
import { Actor } from './event';
import type { TaskViewer } from './task';
import { canSeeTask, TaskKey } from './task';
import type { Task } from './task';

/** The one size limit of an attachment: 25 MB (decimal), enforced on every way in. */
export const MAX_ATTACHMENT_BYTES = 25_000_000;

/** A stored file name is cut to this many UTF-8 bytes (the usual file system limit). */
export const MAX_ATTACHMENT_FILE_NAME_BYTES = 255;

/** What a client may render of a file in the page: a raster image, a PDF, or nothing (download only). */
export const AttachmentPreview = z.enum(['image', 'pdf', 'none']);
export type AttachmentPreview = z.infer<typeof AttachmentPreview>;

/** The media type of every file whose content is not a supported image or PDF. */
export const OCTET_STREAM = 'application/octet-stream';

/**
 * The media types that may be shown inline, with their preview category. The server assigns
 * them from the file's content, never from the name or the type the client declared; HTML and
 * SVG are not among them.
 */
export const INLINE_MEDIA_TYPES = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'application/pdf': 'pdf',
} as const satisfies Record<string, Exclude<AttachmentPreview, 'none'>>;

export function attachmentPreviewOf(mediaType: string): AttachmentPreview {
  return (INLINE_MEDIA_TYPES as Record<string, Exclude<AttachmentPreview, 'none'>>)[mediaType] ?? 'none';
}

/** Server generated identifier of an attachment ("att_…"); also names its file in storage. */
export const AttachmentId = z.string().regex(/^att_[a-z0-9]{10,32}$/);
export type AttachmentId = z.infer<typeof AttachmentId>;

/**
 * A file attached to a task, as the web sees it. The file's place in storage is not part of
 * it: the content is reached only through the protected REST routes.
 */
export const Attachment = z.object({
  id: AttachmentId,
  projectKey: z.string(),
  taskKey: TaskKey,
  /** The sanitised original name: metadata only, never a path. */
  fileName: z.string(),
  /** Bytes, as counted by the server while it stored the file. */
  size: z.number().int().nonnegative(),
  /** Verified from the content: an inline type of `INLINE_MEDIA_TYPES`, else `application/octet-stream`. */
  mediaType: z.string(),
  preview: AttachmentPreview,
  uploadedBy: Actor,
  createdAt: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;

export const AttachmentListResponse = z.object({ attachments: z.array(Attachment) });
export type AttachmentListResponse = z.infer<typeof AttachmentListResponse>;

export const UploadAttachmentResponse = z.object({ attachment: Attachment });
export type UploadAttachmentResponse = z.infer<typeof UploadAttachmentResponse>;

export const DeleteAttachmentResponse = z.object({ id: AttachmentId, deleted: z.literal(true) });
export type DeleteAttachmentResponse = z.infer<typeof DeleteAttachmentResponse>;

/**
 * A person's choice of a card's cover (PM-224): a given image, or no cover at all. Without a
 * choice the cover is automatic (the first image).
 */
export const TaskCoverChoice = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('pinned'), attachmentId: AttachmentId }),
  z.object({ mode: z.literal('hidden') }),
]);
export type TaskCoverChoice = z.infer<typeof TaskCoverChoice>;

/** The body of `PUT routes.taskCover`. */
export const TaskCoverRequest = TaskCoverChoice;
export type TaskCoverRequest = TaskCoverChoice;

/**
 * The cover of a card. `attachments` are the task's ready attachments, oldest first. The server
 * and the web's test backend both use this rule:
 * - `hidden` choice: no cover, whatever is uploaded later;
 * - `pinned` choice: the chosen image while it is still among the ready images;
 * - otherwise (no choice, or the chosen file is gone or not an image): the oldest verified image, or null.
 */
export function coverAttachmentId(
  attachments: ReadonlyArray<Pick<Attachment, 'id' | 'preview'>>,
  choice?: TaskCoverChoice | null,
): string | null {
  if (choice?.mode === 'hidden') return null;
  const images = attachments.filter((attachment) => attachment.preview === 'image');
  if (choice?.mode === 'pinned') {
    const pinned = images.find((attachment) => attachment.id === choice.attachmentId);
    if (pinned) return pinned.id;
  }
  return images[0]?.id ?? null;
}

/** Whoever acts on attachments: a project member (never a client or viewer who may not see the task). */
export type AttachmentViewer = TaskViewer;

/** Reading: project membership is a precondition of every rule; clients see only shared tasks. */
export function canReadAttachments(viewer: AttachmentViewer, task: Pick<Task, 'visibility'>): boolean {
  return canSeeTask(viewer, task);
}

/** Uploading: whoever sees the task, except viewers, who only read (AI and the other workers may). */
export function canUploadAttachment(viewer: AttachmentViewer, task: Pick<Task, 'visibility'>): boolean {
  return canSeeTask(viewer, task) && viewer.access !== 'viewer';
}

/**
 * Deleting: the uploader, or a human owner or admin. A viewer never deletes, not even an
 * older upload of their own.
 */
export function canDeleteAttachment(
  viewer: AttachmentViewer,
  task: Pick<Task, 'visibility'>,
  attachment: Pick<Attachment, 'uploadedBy'>,
): boolean {
  if (!canSeeTask(viewer, task) || viewer.access === 'viewer') return false;
  if (viewer.access === 'owner' || viewer.access === 'admin') return true;
  const kind = viewer.access === 'ai' ? 'ai' : 'human';
  return attachment.uploadedBy.kind === kind && attachment.uploadedBy.handle === viewer.handle;
}

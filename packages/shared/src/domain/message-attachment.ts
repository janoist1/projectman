import { z } from 'zod';
import { AttachmentPreview } from './attachment';
import { Actor } from './event';
import type { TaskViewer } from './task';

/** Server generated identifier of a file attached to a team message ("msa_…"); also names its file in storage. */
export const MessageAttachmentId = z.string().regex(/^msa_[a-z0-9]{10,32}$/);
export type MessageAttachmentId = z.infer<typeof MessageAttachmentId>;

/** Files in one message. */
export const MAX_MESSAGE_ATTACHMENTS = 10;

/** Uploads one member may hold that no message has taken yet. */
export const MAX_UNSENT_MESSAGE_ATTACHMENTS = 20;

/** A file of a message as the message carries it: what a reader needs to show it and to open it. */
export const MessageAttachmentRef = z.object({
  id: MessageAttachmentId,
  fileName: z.string().min(1),
  size: z.number().int().nonnegative(),
  mediaType: z.string(),
  preview: AttachmentPreview,
  /** Deleted (ISO time): the entry stays in the message, the file is gone. */
  goneAt: z.string().optional(),
  goneBy: Actor.optional(),
});
export type MessageAttachmentRef = z.infer<typeof MessageAttachmentRef>;

/** An uploaded file; `messageId` is set once a message took it. */
export const MessageAttachment = z.object({
  id: MessageAttachmentId,
  projectKey: z.string(),
  fileName: z.string(),
  size: z.number().int().nonnegative(),
  mediaType: z.string(),
  preview: AttachmentPreview,
  uploadedBy: Actor,
  createdAt: z.string(),
  messageId: z.string().optional(),
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

export const UploadMessageAttachmentResponse = z.object({ attachment: MessageAttachment });
export type UploadMessageAttachmentResponse = z.infer<typeof UploadMessageAttachmentResponse>;

export const DeleteMessageAttachmentResponse = z.object({
  id: MessageAttachmentId,
  deleted: z.literal(true),
});
export type DeleteMessageAttachmentResponse = z.infer<typeof DeleteMessageAttachmentResponse>;

/**
 * Deleting a message's file: its uploader (the same kind and handle), or an owner or an admin. The
 * viewer must also be able to see the file (the sender and recipients of its message; an unsent file
 * only its uploader); the caller checks that first.
 */
export function canDeleteMessageAttachment(
  viewer: TaskViewer,
  attachment: Pick<MessageAttachment, 'uploadedBy'>,
): boolean {
  if (viewer.access === 'owner' || viewer.access === 'admin') return true;
  const kind = viewer.access === 'ai' ? 'ai' : 'human';
  return attachment.uploadedBy.kind === kind && attachment.uploadedBy.handle === viewer.handle;
}

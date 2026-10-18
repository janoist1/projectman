import { z } from 'zod';
import { DocWriteFailure } from '../config/project-docs';
import { Attachment } from '../domain/attachment';
import { InboxItem } from '../domain/inbox';
import { MessageAttachmentRef } from '../domain/message-attachment';

/**
 * What the bearer MCP adds to the Operator's tools for the integrator in super mode (PM-784): the durable
 * readers for the answers it cannot wait for, and the chunked file content. The inputs of the shared
 * tools keep their own schemas; these are the results and the two new readers' inputs.
 */

/** `get_super_question`: the integrator's own question and, once a person answered it, the answer. */
export const GetSuperQuestionInput = z.strictObject({ item_id: z.string().trim().min(1).max(100) });
export type GetSuperQuestionInput = z.infer<typeof GetSuperQuestionInput>;

/** `get_project_doc_write`: one document write the same owner's keys made. */
export const GetProjectDocWriteInput = z.strictObject({ write_id: z.string().trim().min(1).max(100) });
export type GetProjectDocWriteInput = z.infer<typeof GetProjectDocWriteInput>;

export const ExternalQuestionRead = z.strictObject({
  item: InboxItem,
  /** The free-text answer; null while the question is open, and after it was withdrawn or closed. */
  answer: z.string().nullable(),
  /** The files the answer carries, as the answer message holds them now (a deleted one stays, marked). */
  answer_attachments: z.array(MessageAttachmentRef),
});
export type ExternalQuestionRead = z.infer<typeof ExternalQuestionRead>;

export const ExternalDocWriteState = z.strictObject({
  write_id: z.string(),
  state: z.enum(['queued', 'running', 'published', 'stale', 'failed']),
  /** The written commit; only a published write has it. */
  commit: z.string().nullable(),
  /** The repository-relative paths the write edits. */
  paths: z.array(z.string()),
  /** Only a published write whose local checkout could not follow the default branch. */
  warning: z.literal('local_checkout').nullable(),
  /** Only a failed write. */
  failure: DocWriteFailure.nullable(),
});
export type ExternalDocWriteState = z.infer<typeof ExternalDocWriteState>;

/** The most `read_attachment` returns in one call, and the default when `max_bytes` is left out. */
export const EXTERNAL_ATTACHMENT_MAX_CHUNK_BYTES = 1_048_576;
export const EXTERNAL_ATTACHMENT_DEFAULT_CHUNK_BYTES = 262_144;
/** The largest file `read_attachment` serves, over several calls. */
export const EXTERNAL_ATTACHMENT_MAX_FILE_BYTES = 25 * 1_048_576;

export const ExternalAttachmentRead = z.strictObject({
  attachment: Attachment,
  content: z.strictObject({
    encoding: z.literal('base64'),
    data: z.string(),
    offset_bytes: z.number().int().nonnegative(),
    byte_length: z.number().int().nonnegative(),
    total_bytes: z.number().int().nonnegative(),
    /** Where the next call starts; null when this chunk reaches the end of the file. */
    next_offset: z.number().int().nonnegative().nullable(),
  }),
});
export type ExternalAttachmentRead = z.infer<typeof ExternalAttachmentRead>;

import { CommentAttachmentRef } from '@projectman/shared';
import type { TimelineEvent } from '@projectman/shared';
import { t } from '../i18n/t';

const REFS = CommentAttachmentRef.array();

/** The files of a comment (a `task_note` event), as the server stored them; `gone` is set once one is deleted. */
export function commentFiles(event: Pick<TimelineEvent, 'data'>): CommentAttachmentRef[] {
  const parsed = REFS.safeParse(event.data.attachments);
  return parsed.success ? parsed.data : [];
}

/** A file-only comment as one line: the file's name, or how many files there are. */
export function commentFilesExcerpt(files: readonly CommentAttachmentRef[]): string {
  if (files.length === 0) return '';
  return files.length === 1
    ? files[0]!.fileName
    : t('messageAttachments.previewMany', { count: files.length });
}

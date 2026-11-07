import { useEffect } from 'react';
import { MAX_COMMENT_ATTACHMENTS, routes } from '@projectman/shared';
import { api } from '../../api/endpoints';
import { t } from '../../i18n/t';
import { useAttachmentUploads } from '../messages/useMessageAttachmentUploads';
import type { AttachmentUpload } from '../messages/useMessageAttachmentUploads';
import type { DraftFile, useCardCommentDraft } from './useCardCommentDraft';

/**
 * The uploads that were still running, or failed, when their comment box closed (a change of the view, Mégse
 * on a reply): the bytes are in the browser only, so the box that opens again shows them as failed, with
 * Retry, and nothing vanishes silently. A reload loses them, as it loses any file the browser held.
 */
const parked = new Map<string, AttachmentUpload<DraftFile>[]>();

const sameFiles = (a: readonly DraftFile[], b: readonly DraftFile[]) =>
  a.length === b.length && a.every((file, index) => file.id === b[index]!.id);

/**
 * The tray of one comment box: files go to the card at once, unsent, and the draft keeps the ready ones so the
 * tray comes back with the box. The comment is sent with their ids.
 */
export function useCommentAttachmentUploads(
  projectKey: string,
  taskKey: string,
  slot: string,
  draft: ReturnType<typeof useCardCommentDraft>,
) {
  const place = `${projectKey}:${taskKey}:${slot}`;
  const uploads = useAttachmentUploads<DraftFile>({
    upload: (file, signal) =>
      api.uploadCommentAttachment(projectKey, taskKey, file, signal).then(({ attachment }) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        size: attachment.size,
        mediaType: attachment.mediaType,
        preview: attachment.preview,
      })),
    remove: (id) => api.deleteAttachment(projectKey, taskKey, id),
    max: MAX_COMMENT_ATTACHMENTS,
    tooManyText: t('task.comments.tooManyFiles', { max: MAX_COMMENT_ATTACHMENTS }),
    initial: () => {
      const restored = draft.attachments.map((file) => ({
        file: null,
        name: file.fileName,
        size: file.size,
        // After a reload the picture is the server's thumbnail; any other file is its icon.
        src: file.preview === 'image' ? routes.attachmentThumbnail(projectKey, taskKey, file.id) : undefined,
        status: 'ready' as const,
        attachment: file,
      }));
      const waiting = parked.get(place) ?? [];
      parked.delete(place);
      return [...restored, ...waiting];
    },
    onDetach: (items) => {
      parked.set(place, items);
    },
  });
  const { items } = uploads;
  const { attachments, setAttachments } = draft;
  useEffect(() => {
    const ready = items.flatMap((item) =>
      item.status === 'ready' && item.attachment ? [item.attachment] : [],
    );
    if (!sameFiles(ready, attachments)) setAttachments(ready);
  }, [items, attachments, setAttachments]);
  return uploads;
}

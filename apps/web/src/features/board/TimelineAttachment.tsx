import { useState } from 'react';
import type { ReactNode } from 'react';
import { attachmentPreviewOf, routes } from '@projectman/shared';
import type { Task, TimelineEvent } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { t } from '../../i18n/t';
import { AttachmentImageDialog } from './AttachmentImageDialog';
import { AttachmentOpenLink } from './AttachmentOpenLink';
import styles from './TimelineAttachment.module.css';

interface OpenImage {
  id: string;
  fileName: string;
  size: number;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * The attachment rows of a card's timeline as links, by the same rules as the card's file list: an
 * image opens in the large view, a PDF in a tab of its own, and every other file is offered as a
 * download. All of it goes through the protected content routes. A file that was deleted since
 * stays plain text (its route would answer 404).
 */
export function useAttachmentRows(
  task: Task,
  events: readonly TimelineEvent[],
): { renderText: (event: TimelineEvent) => ReactNode; dialog: ReactNode } {
  const { key } = useProject();
  const [open, setOpen] = useState<OpenImage | null>(null);
  const deleted = new Set(
    events
      .filter((event) => event.type === 'attachment_deleted')
      .map((event) => text(event.data.attachmentId)),
  );

  const renderText = (event: TimelineEvent): ReactNode => {
    if (event.type !== 'attachment_added') return null;
    const id = text(event.data.attachmentId);
    const fileName = text(event.data.fileName);
    const lead = t('timeline.attachmentAddedLead');
    if (!id || deleted.has(id)) return t('timeline.attachmentAdded', { fileName });
    const preview = attachmentPreviewOf(text(event.data.mediaType));
    const size = Number(event.data.size) || 0;
    const link = (
      <AttachmentOpenLink
        projectKey={key}
        taskKey={task.key}
        attachment={{ id, fileName, preview }}
        onPreview={() => setOpen({ id, fileName, size })}
        className={styles.link}
        iconClassName={styles.icon}
      >
        {fileName}
      </AttachmentOpenLink>
    );
    return (
      <>
        {lead} {link}
      </>
    );
  };

  const dialog = (
    <AttachmentImageDialog
      image={
        open && !deleted.has(open.id)
          ? {
              fileName: open.fileName,
              size: open.size,
              src: routes.attachmentContent(key, task.key, open.id),
            }
          : null
      }
      onClose={() => setOpen(null)}
    />
  );
  return { renderText, dialog };
}

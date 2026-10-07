import { useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { attachmentPreviewOf, routes } from '@projectman/shared';
import type { Task, TimelineEvent } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { Timeline } from '../../components/Timeline';
import { t } from '../../i18n/t';
import { AttachmentImageDialog } from './AttachmentImageDialog';
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
export function TaskTimeline({
  task,
  events,
  ...timeline
}: { task: Task; events: readonly TimelineEvent[] } & Omit<ComponentProps<typeof Timeline>, 'renderText'>) {
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
    const content = routes.attachmentContent(key, task.key, id);
    // The same words as the card's file list name the action (label and tooltip).
    const link =
      preview === 'image' ? (
        <button
          type="button"
          className={styles.link}
          aria-label={t('attachments.previewLabel', { fileName })}
          title={t('attachments.previewLabel', { fileName })}
          onClick={() => setOpen({ id, fileName, size })}
        >
          <Icon name="eye" size={14} strokeWidth={2.1} className={styles.icon} />
          {fileName}
        </button>
      ) : preview === 'pdf' ? (
        // A PDF opens in a tab of its own, from the protected route: never inside this page.
        <a
          className={styles.link}
          href={content}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('attachments.openPdfLabel', { fileName })}
          title={t('attachments.openPdfLabel', { fileName })}
        >
          <Icon name="external" size={14} strokeWidth={2.1} className={styles.icon} />
          {fileName}
        </a>
      ) : (
        <a
          className={styles.link}
          href={routes.attachmentDownload(key, task.key, id)}
          download
          aria-label={t('attachments.downloadLabel', { fileName })}
          title={t('attachments.downloadLabel', { fileName })}
        >
          <Icon name="download" size={14} strokeWidth={2.1} className={styles.icon} />
          {fileName}
        </a>
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
  return (
    <>
      <Timeline {...timeline} events={events} renderText={renderText} />
      {dialog}
    </>
  );
}

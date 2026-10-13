import { useId, useState } from 'react';
import { questionAttachmentsOf, routes } from '@projectman/shared';
import type { InboxItem, QuestionAttachment } from '@projectman/shared';
import { Icon } from '../../components/Icon';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import { AttachmentImageDialog } from '../board/AttachmentImageDialog';
import { AttachmentOpenLink } from '../board/AttachmentOpenLink';
import styles from './QuestionAttachments.module.css';

/**
 * The files a question names (PM-498) as tiles: an image opens in the large view, a PDF in a tab of
 * its own, every other file downloads, all through the protected routes of the card the file is on
 * (the question's card or its parent). A file deleted since is a plain tile without a link. A
 * question that names no file (every older one) shows nothing.
 */
export function QuestionAttachments({ item, projectKey }: { item: InboxItem; projectKey: string }) {
  const files = questionAttachmentsOf(item);
  const titleId = useId();
  const [openId, setOpenId] = useState<string | null>(null);
  if (files.length === 0) return null;

  // A file deleted while the large view is open closes it: its route would answer 404.
  const open = files.find((file) => file.id === openId && file.goneAt === undefined) ?? null;
  return (
    <div className={styles.group} role="group" aria-labelledby={titleId}>
      <span id={titleId} className={styles.title}>
        {t('inbox.attachments.title')}
      </span>
      <ul className={styles.tiles}>
        {files.map((file) => (
          <li key={file.id} className={styles.item}>
            <Tile
              file={file}
              projectKey={projectKey}
              parentKey={file.taskKey !== item.taskKey ? file.taskKey : null}
              onPreview={() => setOpenId(file.id)}
            />
          </li>
        ))}
      </ul>
      <AttachmentImageDialog
        image={
          open
            ? {
                fileName: open.fileName,
                size: open.size,
                src: routes.attachmentContent(projectKey, open.taskKey, open.id),
              }
            : null
        }
        onClose={() => setOpenId(null)}
      />
    </div>
  );
}

function Tile({
  file,
  projectKey,
  parentKey,
  onPreview,
}: {
  file: QuestionAttachment;
  projectKey: string;
  /** The card the file is on, when that is not the question's own card. */
  parentKey: string | null;
  onPreview: () => void;
}) {
  const fromCard = parentKey ? t('inbox.attachments.fromCard', { key: parentKey }) : '';
  const key = parentKey ? (
    <span className={styles.key} aria-hidden="true">
      {parentKey}
    </span>
  ) : null;
  const name = <span className={styles.name}>{file.fileName}</span>;

  if (file.goneAt !== undefined) {
    // A plain span is read by few screen readers with an aria-label: the label is hidden text.
    return (
      <span className={`${styles.tile} ${styles.gone}`} title={t('inbox.attachments.goneTitle')}>
        <span className="visually-hidden">
          {t('inbox.attachments.goneLabel', { fileName: file.fileName })}
          {fromCard}
        </span>
        <Icon name="ban" size={14} strokeWidth={2.1} className={styles.icon} />
        <span className={styles.goneText} aria-hidden="true">
          {key}
          {name}
          <span className={styles.size}>{t('inbox.attachments.gone')}</span>
        </span>
      </span>
    );
  }
  return (
    <AttachmentOpenLink
      projectKey={projectKey}
      taskKey={file.taskKey}
      attachment={file}
      onPreview={onPreview}
      className={styles.tile}
      iconClassName={styles.icon}
      labelSuffix={fromCard}
    >
      {key}
      {name}
      {file.size > 0 ? <span className={styles.size}>{formatBytes(file.size)}</span> : null}
    </AttachmentOpenLink>
  );
}

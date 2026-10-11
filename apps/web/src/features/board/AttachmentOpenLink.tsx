import type { ReactNode } from 'react';
import { routes } from '@projectman/shared';
import type { AttachmentPreview } from '@projectman/shared';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';

/**
 * The one rule for opening a file of a card: an image opens in the large view (the caller holds the
 * dialog), a PDF in a tab of its own, and every other file is offered as a download. All of it goes
 * through the protected content routes of the card the file is on. The timeline and the question's
 * file tiles share it, so the same file always behaves the same way.
 */
export function AttachmentOpenLink({
  projectKey,
  taskKey,
  attachment,
  onPreview,
  className,
  iconClassName,
  labelSuffix = '',
  children,
}: {
  projectKey: string;
  /** The card the file is on: its protected routes. */
  taskKey: string;
  attachment: { id: string; fileName: string; preview: AttachmentPreview };
  /** An image opens in the large view; the caller holds the dialog. */
  onPreview: () => void;
  className?: string;
  iconClassName?: string;
  /** Words added to the end of the aria-label and the title (e.g. ", a BZ-1 kártyáról"). */
  labelSuffix?: string;
  children: ReactNode;
}) {
  const { id, fileName, preview } = attachment;
  // The same words as the card's file list name the action (label and tooltip).
  const icon = (name: 'eye' | 'external' | 'download') => (
    <Icon name={name} size={14} strokeWidth={2.1} className={iconClassName} />
  );
  if (preview === 'image') {
    const label = t('attachments.previewLabel', { fileName }) + labelSuffix;
    return (
      <button type="button" className={className} aria-label={label} title={label} onClick={onPreview}>
        {icon('eye')}
        {children}
      </button>
    );
  }
  if (preview === 'pdf') {
    const label = t('attachments.openPdfLabel', { fileName }) + labelSuffix;
    // A PDF opens in a tab of its own, from the protected route: never inside this page.
    return (
      <a
        className={className}
        href={routes.attachmentContent(projectKey, taskKey, id)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        title={label}
      >
        {icon('external')}
        {children}
      </a>
    );
  }
  const label = t('attachments.downloadLabel', { fileName }) + labelSuffix;
  return (
    <a
      className={className}
      href={routes.attachmentDownload(projectKey, taskKey, id)}
      download
      aria-label={label}
      title={label}
    >
      {icon('download')}
      {children}
    </a>
  );
}

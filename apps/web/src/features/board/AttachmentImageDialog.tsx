import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import styles from './TaskAttachments.module.css';

/** The large view of an image attachment, from the protected content route (the card's list, the timeline and a question's files share it). */
export function AttachmentImageDialog({
  image,
  onClose,
}: {
  /** The image to show; null keeps the dialog closed. */
  image: { fileName: string; size: number; src: string } | null;
  onClose: () => void;
}) {
  // The address that failed: another image (a new `src`) starts without the error.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = image !== null && failedSrc === image.src;
  return (
    <Dialog
      open={image !== null}
      onClose={onClose}
      title={image?.fileName ?? ''}
      description={image ? formatBytes(image.size) : undefined}
      size="lg"
    >
      {image && failed ? (
        <div className={styles.imageFailed} role="status">
          <Icon name="alertCircle" size={24} />
          <p className={styles.imageFailedTitle}>{t('attachments.imageFailed')}</p>
          <p className={styles.imageFailedHint}>{t('attachments.imageFailedHint')}</p>
        </div>
      ) : image ? (
        <img
          className={styles.large}
          src={image.src}
          alt={t('attachments.previewOf', { fileName: image.fileName })}
          onError={() => setFailedSrc(image.src)}
        />
      ) : null}
    </Dialog>
  );
}

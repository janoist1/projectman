import { useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/Button';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import styles from './TaskAttachments.module.css';

/** The large view of an image attachment, from the protected content route (the card's list, the timeline and a question's files share it). */
export function AttachmentImageDialog({
  image,
  onClose,
  navigation,
  footer,
  error,
  messageAttachment = false,
  returnFocusRef,
  returnFocusFallback,
}: {
  /** The image to show; null keeps the dialog closed. */
  image: { fileName: string; size: number; src: string } | null;
  onClose: () => void;
  navigation?: { index: number; count: number; onPrev: () => void; onNext: () => void };
  footer?: ReactNode;
  error?: ReactNode;
  messageAttachment?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  returnFocusFallback?: () => HTMLElement | null;
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
      footer={footer}
      error={error}
      returnFocusRef={returnFocusRef}
      returnFocusFallback={returnFocusFallback}
    >
      {navigation ? (
        <div className={styles.imageNavigation}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon="chevronLeft"
            onClick={navigation.onPrev}
            disabled={navigation.index === 0}
          >
            {t('messageAttachments.prev')}
          </Button>
          <span aria-live="polite">
            {t('messageAttachments.position', { index: navigation.index + 1, count: navigation.count })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            iconRight="chevronRight"
            onClick={navigation.onNext}
            disabled={navigation.index === navigation.count - 1}
          >
            {t('messageAttachments.next')}
          </Button>
        </div>
      ) : null}
      {image && failed ? (
        <div className={styles.imageFailed} role="status">
          <Icon name="alertCircle" size={24} />
          <p className={styles.imageFailedTitle}>{t('attachments.imageFailed')}</p>
          <p className={styles.imageFailedHint}>
            {t(messageAttachment ? 'messageAttachments.imageFailedHint' : 'attachments.imageFailedHint')}
          </p>
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

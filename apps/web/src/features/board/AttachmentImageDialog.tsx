import { Dialog } from '../../components/Dialog';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import styles from './TaskAttachments.module.css';

/** The large view of an image attachment, from the protected content route (the card's list and the timeline share it). */
export function AttachmentImageDialog({
  image,
  onClose,
}: {
  /** The image to show; null keeps the dialog closed. */
  image: { fileName: string; size: number; src: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={image !== null}
      onClose={onClose}
      title={image?.fileName ?? ''}
      description={image ? formatBytes(image.size) : undefined}
      size="lg"
    >
      {image ? (
        <img
          className={styles.large}
          src={image.src}
          alt={t('attachments.previewOf', { fileName: image.fileName })}
        />
      ) : null}
    </Dialog>
  );
}

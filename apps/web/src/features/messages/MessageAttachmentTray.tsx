import { useRef } from 'react';
import { Icon } from '../../components/Icon';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import type { AttachmentUpload } from './useMessageAttachmentUploads';
import styles from './MessageAttachments.module.css';

/**
 * The files waiting to be sent with a message or a comment. A file the server no longer has (`gone`) is
 * marked and can only be removed.
 */
export function MessageAttachmentTray({
  items,
  onRemove,
  onRetry,
  focusInput,
  disabled,
  label = t('messageAttachments.trayLabel'),
  comment = false,
}: {
  items: readonly Pick<AttachmentUpload<{ id: string }>, 'id' | 'name' | 'size' | 'src' | 'status'>[];
  onRemove: (id: number) => Promise<boolean>;
  onRetry: (id: number) => void;
  focusInput: () => void;
  disabled: boolean;
  label?: string;
  /** A comment's tray: a failed file is a warning and the tray scrolls after two rows. */
  comment?: boolean;
}) {
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  if (!items.length) return null;
  const errorClass = `${styles.uploadError} ${comment ? styles.uploadErrorComment : ''}`;
  return (
    <>
      <ul className={`${styles.tray} ${comment ? styles.trayComment : ''}`} aria-label={label}>
        {items.map((item, index) => (
          <li
            key={item.id}
            className={`${styles.draft} ${item.src ? styles.draftImage : styles.draftFile} ${item.status === 'failed' || item.status === 'gone' ? styles.failed : ''}`}
            aria-label={t('messageAttachments.itemLabel', {
              fileName: item.name,
              size: formatBytes(item.size),
              state: t(
                item.status === 'gone'
                  ? 'messageAttachments.unavailableState'
                  : `messageAttachments.${item.status}`,
              ),
            })}
            aria-busy={item.status === 'uploading'}
          >
            {item.src ? (
              <img src={item.src} alt="" />
            ) : (
              <>
                <Icon name="doc" size={20} />
                <span className={styles.fileName}>{item.name}</span>
                <span>{formatBytes(item.size)}</span>
              </>
            )}
            <button
              type="button"
              className={styles.remove}
              aria-disabled={disabled || undefined}
              ref={(node) => {
                if (node) buttons.current.set(item.id, node);
                else buttons.current.delete(item.id);
              }}
              aria-label={t('messageAttachments.remove', { fileName: item.name })}
              onClick={() => {
                if (disabled) return;
                const next = items[index + 1]?.id;
                void onRemove(item.id).then((removed) => {
                  if (!removed) return;
                  const target = next === undefined ? null : buttons.current.get(next);
                  if (target) target.focus();
                  else focusInput();
                });
              }}
            >
              <Icon name="close" size={14} />
            </button>
            {item.status === 'uploading' ? <span className={styles.progress} /> : null}
          </li>
        ))}
      </ul>
      {items
        .filter((item) => item.status === 'failed')
        .map((item) => (
          <div key={item.id} className={errorClass} role="alert">
            {t('messageAttachments.uploadFailed', { fileName: item.name })}
            <button
              type="button"
              aria-disabled={disabled || undefined}
              onClick={() => {
                if (!disabled) onRetry(item.id);
              }}
            >
              {t('attachments.retry')}
            </button>
          </div>
        ))}
      {items
        .filter((item) => item.status === 'gone')
        .map((item) => (
          <div key={item.id} className={errorClass} role="alert">
            {t('messageAttachments.unavailable', { fileName: item.name })}
          </div>
        ))}
    </>
  );
}

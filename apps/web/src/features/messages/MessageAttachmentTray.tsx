import { useRef } from 'react';
import { Icon } from '../../components/Icon';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import type { MessageUpload } from './useMessageAttachmentUploads';
import styles from './MessageAttachments.module.css';

export function MessageAttachmentTray({
  items,
  onRemove,
  onRetry,
  focusInput,
  disabled,
}: {
  items: readonly MessageUpload[];
  onRemove: (id: number) => Promise<boolean>;
  onRetry: (id: number) => void;
  focusInput: () => void;
  disabled: boolean;
}) {
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  if (!items.length) return null;
  return (
    <>
      <ul className={styles.tray} aria-label={t('messageAttachments.trayLabel')}>
        {items.map((item, index) => (
          <li
            key={item.id}
            className={`${styles.draft} ${item.src ? styles.draftImage : styles.draftFile} ${item.status === 'failed' ? styles.failed : ''}`}
            aria-label={t('messageAttachments.itemLabel', {
              fileName: item.file.name,
              size: formatBytes(item.file.size),
              state: t(`messageAttachments.${item.status}`),
            })}
            aria-busy={item.status === 'uploading'}
          >
            {item.src ? (
              <img src={item.src} alt="" />
            ) : (
              <>
                <Icon name="doc" size={20} />
                <span className={styles.fileName}>{item.file.name}</span>
                <span>{formatBytes(item.file.size)}</span>
              </>
            )}
            <button
              type="button"
              className={styles.remove}
              disabled={disabled}
              ref={(node) => {
                if (node) buttons.current.set(item.id, node);
                else buttons.current.delete(item.id);
              }}
              aria-label={t('messageAttachments.remove', { fileName: item.file.name })}
              onClick={() => {
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
          <div key={item.id} className={styles.uploadError} role="alert">
            {t('messageAttachments.uploadFailed', { fileName: item.file.name })}
            <button type="button" disabled={disabled} onClick={() => onRetry(item.id)}>
              {t('attachments.retry')}
            </button>
          </div>
        ))}
    </>
  );
}

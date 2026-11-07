import { useEffect, useRef, useState } from 'react';
import { routes } from '@projectman/shared';
import type { AttachmentPreview } from '@projectman/shared';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import { AttachmentImageDialog } from '../board/AttachmentImageDialog';
import { AttachmentOpenLink } from '../board/AttachmentOpenLink';
import styles from './MessageAttachments.module.css';

export interface AttachmentFile {
  id: string;
  fileName: string;
  size: number;
  preview: AttachmentPreview;
  /** The file was deleted after it was sent: a tile that says so remains. */
  gone: boolean;
}

/**
 * The files of a message or a comment: a grid of image thumbnails, tiles for the others, the large view and
 * the delete confirmation. A message's files have routes of their own; a comment's are files of its card
 * (`taskKey`), reached through the card's protected routes.
 */
export function AttachmentFiles({
  files,
  projectKey,
  taskKey,
  canDelete,
  onDelete,
  deleteConfirmKey,
  focusFallback,
}: {
  files: readonly AttachmentFile[];
  projectKey: string;
  /** Set for a comment's files; absent for a message's. */
  taskKey?: string;
  canDelete: boolean;
  onDelete: (id: string) => Promise<unknown>;
  deleteConfirmKey: 'messageAttachments.deleteConfirm' | 'messageAttachments.commentDeleteConfirm';
  /** Where focus goes when the open image is gone: the composer's field next to the files. */
  focusFallback: (container: HTMLElement | null) => HTMLElement | null;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [restoreInput, setRestoreInput] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const fallbackInput = () => focusFallback(container.current);
  const urls = {
    thumbnail: (id: string) =>
      taskKey
        ? routes.attachmentThumbnail(projectKey, taskKey, id)
        : routes.messageAttachmentThumbnail(projectKey, id),
    content: (id: string) =>
      taskKey
        ? routes.attachmentContent(projectKey, taskKey, id)
        : routes.messageAttachmentContent(projectKey, id),
    download: (id: string) =>
      taskKey
        ? routes.attachmentDownload(projectKey, taskKey, id)
        : routes.messageAttachmentDownload(projectKey, id),
  };
  const images = files.filter((file) => file.preview === 'image' && !file.gone);
  const open = images.find((file) => file.id === openId) ?? null;
  const index = images.findIndex((file) => file.id === openId);
  useEffect(() => {
    if (openId && !open) {
      trigger.current = null;
      setOpenId(null);
      setConfirmId(null);
      setRestoreInput(true);
    }
  }, [openId, open]);
  useEffect(() => {
    if (!restoreInput) return;
    fallbackInput()?.focus();
    setRestoreInput(false);
  }, [restoreInput]);
  const deleteFile = (id: string) => {
    setError(null);
    setPending(true);
    void onDelete(id).then(
      () => {
        setPending(false);
        setConfirmId(null);
        if (id === openId) {
          trigger.current = null;
          setOpenId(null);
          setRestoreInput(true);
        }
      },
      () => {
        setPending(false);
        setError(t('messageAttachments.deleteFailed'));
      },
    );
  };
  const confirmation = (file: AttachmentFile) => (
    <div className={styles.confirm}>
      <span>{t(deleteConfirmKey, { fileName: file.fileName })}</span>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmId(null)}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" variant="danger" disabled={pending} onClick={() => deleteFile(file.id)}>
        {t('attachments.deleteYes')}
      </Button>
    </div>
  );
  if (!files.length) return null;
  return (
    <div
      ref={container}
      className={styles.attachments}
      role="group"
      aria-label={t('messageAttachments.groupLabel')}
    >
      {images.length ? (
        <div className={`${styles.grid} ${images.length === 1 ? styles.one : styles.many}`}>
          {images.slice(0, 4).map((file, position) => (
            <Thumbnail
              key={file.id}
              file={file}
              src={urls.thumbnail(file.id)}
              more={position === 3 ? images.length - 3 : 0}
              onOpen={(button) => {
                trigger.current = button;
                setOpenId(file.id);
                setConfirmId(null);
                setError(null);
              }}
            />
          ))}
        </div>
      ) : null}
      {files
        .filter((file) => file.preview !== 'image' || file.gone)
        .map((file) =>
          file.gone ? (
            <span
              key={file.id}
              className={`${styles.tile} ${styles.gone}`}
              title={t('messageAttachments.goneTitle')}
            >
              <span className="visually-hidden">
                {t('messageAttachments.goneLabel', { fileName: file.fileName })}
              </span>
              <span aria-hidden="true" className={styles.tile}>
                <Icon name="ban" size={14} />
                <span className={styles.fileName}>{file.fileName}</span>
                <span>{t('messageAttachments.gone')}</span>
              </span>
            </span>
          ) : (
            <div key={file.id}>
              <div className={styles.fileRow}>
                <AttachmentOpenLink
                  projectKey={projectKey}
                  taskKey={taskKey}
                  messageAttachment={!taskKey}
                  attachment={file}
                  onPreview={() => {}}
                  className={styles.tile}
                >
                  <span className={styles.fileName}>{file.fileName}</span>
                  <span className={styles.size}>{formatBytes(file.size)}</span>
                </AttachmentOpenLink>
                {canDelete ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="trash"
                    aria-label={t('attachments.deleteLabel', { fileName: file.fileName })}
                    onClick={() => {
                      setConfirmId(file.id);
                      setError(null);
                    }}
                  />
                ) : null}
              </div>
              {confirmId === file.id ? confirmation(file) : null}
            </div>
          ),
        )}
      {error && !open ? <span role="alert">{error}</span> : null}
      <div
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === 'Escape') event.stopPropagation();
          if (confirmId || pending) return;
          if (event.key === 'ArrowLeft' && index > 0) {
            event.preventDefault();
            setOpenId(images[index - 1]!.id);
          }
          if (event.key === 'ArrowRight' && index < images.length - 1) {
            event.preventDefault();
            setOpenId(images[index + 1]!.id);
          }
        }}
      >
        <AttachmentImageDialog
          image={open ? { ...open, src: urls.content(open.id) } : null}
          messageAttachment={!taskKey}
          returnFocusRef={trigger}
          returnFocusFallback={fallbackInput}
          onClose={() => {
            setOpenId(null);
            setConfirmId(null);
            setError(null);
          }}
          navigation={
            images.length > 1
              ? {
                  index,
                  count: images.length,
                  onPrev: () => {
                    if (index > 0 && !confirmId && !pending) setOpenId(images[index - 1]!.id);
                  },
                  onNext: () => {
                    if (index < images.length - 1 && !confirmId && !pending) setOpenId(images[index + 1]!.id);
                  },
                }
              : undefined
          }
          error={error ? <span role="alert">{error}</span> : null}
          footer={
            open ? (
              confirmId === open.id ? (
                confirmation(open)
              ) : (
                <>
                  <a href={urls.download(open.id)} download className={styles.tile}>
                    <Icon name="download" size={16} />
                    {t('attachments.download')}
                  </a>
                  {canDelete ? (
                    <Button variant="ghost" icon="trash" onClick={() => setConfirmId(open.id)}>
                      {t('attachments.delete')}
                    </Button>
                  ) : null}
                </>
              )
            ) : null
          }
        />
      </div>
    </div>
  );
}

function Thumbnail({
  file,
  src,
  more,
  onOpen,
}: {
  file: AttachmentFile;
  src: string;
  more: number;
  onOpen: (button: HTMLButtonElement) => void;
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  return (
    <button
      type="button"
      className={`${styles.thumbnail} ${state === 'loading' ? styles.loading : ''}`}
      aria-label={
        more > 1
          ? t('messageAttachments.moreLabel', { count: more, fileName: file.fileName })
          : t('attachments.previewLabel', { fileName: file.fileName })
      }
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {state === 'failed' ? (
        <span className={styles.imageFailed}>
          <Icon name="alertCircle" size={20} />
          {t('attachments.imageFailed')}
        </span>
      ) : (
        <img
          src={src}
          alt=""
          loading="lazy"
          onLoad={() => setState('ready')}
          onError={() => setState('failed')}
        />
      )}
      {more > 1 ? <span className={styles.more}>{t('messageAttachments.more', { count: more })}</span> : null}
    </button>
  );
}

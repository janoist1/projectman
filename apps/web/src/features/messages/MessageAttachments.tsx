import { useEffect, useRef, useState } from 'react';
import { canDeleteMessageAttachment, routes } from '@projectman/shared';
import type { MessageAttachmentRef, TeamMessage } from '@projectman/shared';
import { useDeleteMessageAttachment } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import { AttachmentImageDialog } from '../board/AttachmentImageDialog';
import { AttachmentOpenLink } from '../board/AttachmentOpenLink';
import styles from './MessageAttachments.module.css';

/** Shared bubble content for message files; refs remain visible after their bytes are deleted. */
export function MessageAttachments({
  files,
  from,
  sent = true,
}: {
  files: readonly MessageAttachmentRef[];
  from: TeamMessage['from'];
  sent?: boolean;
}) {
  const { key, me, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const access = me.projects.find((project) => project.key === key)?.access;
  const remove = useDeleteMessageAttachment(key);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreInput, setRestoreInput] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const images = files.filter((file) => file.preview === 'image' && !file.goneAt);
  const open = images.find((file) => file.id === openId) ?? null;
  const index = images.findIndex((file) => file.id === openId);
  const canDelete =
    sent &&
    access &&
    myHandle &&
    canDeleteMessageAttachment(
      { access, handle: myHandle },
      { uploadedBy: { kind: members.get(from)?.kind ?? 'human', handle: from } },
    );
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
    document.querySelector<HTMLTextAreaElement>('#operator-panel textarea')?.focus();
    setRestoreInput(false);
  }, [restoreInput]);
  const deleteFile = (id: string) => {
    setError(null);
    void remove.mutateAsync(id).then(
      () => {
        setConfirmId(null);
        if (id === openId) {
          trigger.current = null;
          setOpenId(null);
          setRestoreInput(true);
        }
      },
      () => setError(t('messageAttachments.deleteFailed')),
    );
  };
  const confirmation = (file: MessageAttachmentRef) => (
    <div className={styles.confirm}>
      <span>{t('messageAttachments.deleteConfirm', { fileName: file.fileName })}</span>
      <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => setConfirmId(null)}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => deleteFile(file.id)}>
        {t('attachments.deleteYes')}
      </Button>
    </div>
  );
  if (!files.length) return null;
  return (
    <div className={styles.attachments} role="group" aria-label={t('messageAttachments.groupLabel')}>
      {images.length ? (
        <div className={`${styles.grid} ${images.length === 1 ? styles.one : styles.many}`}>
          {images.slice(0, 4).map((file, position) => (
            <Thumbnail
              key={file.id}
              file={file}
              projectKey={key}
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
        .filter((file) => file.preview !== 'image' || file.goneAt)
        .map((file) =>
          file.goneAt ? (
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
                  projectKey={key}
                  messageAttachment
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
          if (confirmId || remove.isPending) return;
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
          image={open ? { ...open, src: routes.messageAttachmentContent(key, open.id) } : null}
          messageAttachment
          returnFocusRef={trigger}
          returnFocusFallback={() => document.querySelector<HTMLTextAreaElement>('#operator-panel textarea')}
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
                    if (index > 0 && !confirmId && !remove.isPending) setOpenId(images[index - 1]!.id);
                  },
                  onNext: () => {
                    if (index < images.length - 1 && !confirmId && !remove.isPending)
                      setOpenId(images[index + 1]!.id);
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
                  <a href={routes.messageAttachmentDownload(key, open.id)} download className={styles.tile}>
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
  projectKey,
  more,
  onOpen,
}: {
  file: MessageAttachmentRef;
  projectKey: string;
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
          src={routes.messageAttachmentThumbnail(projectKey, file.id)}
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

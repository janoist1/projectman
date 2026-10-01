import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { MAX_ATTACHMENT_BYTES, canDeleteAttachment, canUploadAttachment, routes } from '@projectman/shared';
import type { Attachment, AttachmentViewer, Task } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useAttachments, useDeleteAttachment } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { ErrorState, LoadingState } from '../../components/States';
import { formatBytes, formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import {
  dragHasFiles,
  droppedFiles,
  isEditableTarget,
  pasteHasText,
  pastedImages,
} from '../../lib/attachmentInput';
import { errorMessage } from '../../lib/errors';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import drawer from './drawer.module.css';
import styles from './TaskAttachments.module.css';
import { useAttachmentUploads } from './useAttachmentUploads';
import type { UploadItem } from './useAttachmentUploads';

/** A refusal (the task is gone, the access is lost) is not a fault to retry: nothing is shown. */
const isRefusal = (error: unknown) => isApiError(error) && (error.status === 403 || error.status === 404);

/** Everything about the file reaches the browser through the protected content routes, by URL. */
function useUrls(task: Task) {
  const { key } = useProject();
  return {
    content: (id: string) => routes.attachmentContent(key, task.key, id),
    download: (id: string) => routes.attachmentDownload(key, task.key, id),
  };
}

function UploadRow({
  item,
  onRetry,
  onDismiss,
}: {
  item: UploadItem;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const name = item.file.name;
  return (
    <li className={styles.upload} data-status={item.status}>
      <div className={styles.info}>
        <span className={styles.name}>{name}</span>
        {item.status === 'failed' ? (
          <span className={styles.failure} role="alert">
            {item.error}
          </span>
        ) : (
          <span className={styles.meta}>
            {item.status === 'uploading' ? t('attachments.uploading') : t('attachments.queued')} ·{' '}
            {formatBytes(item.file.size)}
          </span>
        )}
        {item.status === 'uploading' ? (
          // The browser reports no progress of a request body: the bar only says the file is on its way.
          <progress
            className={styles.progress}
            aria-label={t('attachments.uploadingLabel', { fileName: name })}
          />
        ) : null}
      </div>
      {item.status === 'failed' ? (
        <div className={styles.actions}>
          {item.final ? null : (
            <Button
              size="sm"
              variant="secondary"
              icon="undo"
              onClick={onRetry}
              aria-label={t('attachments.retryLabel', { fileName: name })}
            >
              {t('attachments.retry')}
            </Button>
          )}
          <Button
            size="sm"
            variant="muted"
            onClick={onDismiss}
            aria-label={t('attachments.dismissLabel', { fileName: name })}
          >
            {t('attachments.dismiss')}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function AttachmentRow({
  attachment,
  task,
  members,
  canDelete,
  onPreview,
  onDelete,
  deleting,
  deleteError,
}: {
  attachment: Attachment;
  task: Task;
  members: MemberIndex;
  canDelete: boolean;
  onPreview: (id: string) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
  deleteError: unknown;
}) {
  const { myHandle } = useProject();
  const urls = useUrls(task);
  const [confirming, setConfirming] = useState(false);
  const { id, fileName, preview } = attachment;
  return (
    <li className={styles.item}>
      <div className={styles.thumb}>
        {preview === 'image' ? (
          <button
            type="button"
            className={styles.thumbButton}
            aria-label={t('attachments.previewLabel', { fileName })}
            onClick={() => onPreview(id)}
          >
            {/* Small and lazy: the browser fetches it when it scrolls into view, with the login cookie. */}
            <img
              src={urls.content(id)}
              alt=""
              loading="lazy"
              decoding="async"
              className={styles.thumbImage}
            />
          </button>
        ) : (
          <span className={styles.fileIcon} aria-hidden="true">
            <Icon name="doc" size={20} />
          </span>
        )}
      </div>
      <div className={styles.info}>
        <span className={styles.name}>{fileName}</span>
        <span className={styles.meta}>
          {t('attachments.meta', {
            size: formatBytes(attachment.size),
            who: nameOf(attachment.uploadedBy.handle, members, myHandle),
            when: formatStamp(attachment.createdAt),
          })}
        </span>
        {confirming ? (
          <div
            className={styles.confirm}
            role="group"
            aria-label={t('attachments.deleteLabel', { fileName })}
          >
            <span>{t('attachments.deleteConfirm', { fileName })}</span>
            <div className={styles.actions}>
              <Button
                size="sm"
                variant="danger"
                loading={deleting}
                onClick={() => {
                  setConfirming(false);
                  onDelete(id);
                }}
              >
                {t('attachments.deleteYes')}
              </Button>
              <Button size="sm" variant="muted" onClick={() => setConfirming(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : null}
        {deleteError ? (
          <span className={styles.failure} role="alert">
            {t('attachments.deleteFailed', { reason: errorMessage(deleteError) })}
          </span>
        ) : null}
      </div>
      <div className={styles.actions}>
        {preview === 'pdf' ? (
          // A PDF opens in a tab of its own, from the protected route: never inside this page.
          <a
            className={styles.linkButton}
            href={urls.content(id)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('attachments.openPdfLabel', { fileName })}
          >
            <Icon name="external" size={15} strokeWidth={2.1} />
            {t('attachments.openPdf')}
          </a>
        ) : null}
        <a
          className={styles.linkButton}
          href={urls.download(id)}
          download
          aria-label={t('attachments.downloadLabel', { fileName })}
        >
          <Icon name="download" size={15} strokeWidth={2.1} />
          {t('attachments.download')}
        </a>
        {canDelete && !confirming ? (
          <Button
            size="sm"
            variant="danger"
            icon="trash"
            loading={deleting}
            onClick={() => setConfirming(true)}
            aria-label={t('attachments.deleteLabel', { fileName })}
          >
            {t('attachments.delete')}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The files of a task: pick, drop or paste an image to add them; download, open an image large or a
 * PDF in a new tab, and delete (the uploader, or an owner or admin). What a person may do comes from
 * the shared rules, the same the server judges by. The section remounts for each task, so nothing of
 * another task, or of a task that is no longer visible, stays on screen.
 */
export function TaskAttachments({ task, members }: { task: Task; members: MemberIndex }) {
  const { key, me, myHandle } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const viewer: AttachmentViewer | null = access && myHandle ? { access, handle: myHandle } : null;
  const list = useAttachments(key, task.key, viewer !== null);
  const remove = useDeleteAttachment(key, task.key);
  const uploads = useAttachmentUploads(key, task.key);
  const refused = list.isError && isRefusal(list.error);
  const attachments = refused ? [] : (list.data?.attachments ?? []);
  const canUpload = viewer !== null && !refused && canUploadAttachment(viewer, task);

  const [previewId, setPreviewId] = useState<string | null>(null);
  // Looked up in the current list: a deleted file closes its own large view.
  const previewed = attachments.find(
    (attachment) => attachment.id === previewId && attachment.preview === 'image',
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const addRef = useRef(uploads.add);
  addRef.current = uploads.add;

  // Images pasted from the clipboard. Text, and anything typed or pasted as text, is left alone.
  useEffect(() => {
    if (!canUpload) return;
    const onPaste = (event: ClipboardEvent) => {
      const images = pastedImages(event.clipboardData);
      if (images.length === 0) return;
      // A dialog (the large view, a form) has the focus: the paste is not meant for the task.
      if (document.querySelector('dialog[open]')) return;
      if (isEditableTarget(event.target) && pasteHasText(event.clipboardData)) return;
      event.preventDefault();
      addRef.current(images);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [canUpload]);

  const onChoose = (event: ChangeEvent<HTMLInputElement>) => {
    uploads.add(Array.from(event.target.files ?? []));
    // The same file can be chosen again.
    event.target.value = '';
  };

  const dragProps = canUpload
    ? {
        onDragEnter: (event: DragEvent) => {
          if (!dragHasFiles(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        },
        onDragOver: (event: DragEvent) => {
          if (!dragHasFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: (event: DragEvent) => {
          if (!dragHasFiles(event.dataTransfer)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          if (!dragHasFiles(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          uploads.add(droppedFiles(event.dataTransfer));
        },
      }
    : {};

  const urls = useUrls(task);
  return (
    <section
      className={clsx(drawer.section, styles.section, dragging && styles.dragging)}
      aria-labelledby="task-attachments-title"
      {...dragProps}
    >
      <h3 id="task-attachments-title" className={drawer.sectionTitle}>
        {t('attachments.title')}
      </h3>

      {canUpload ? (
        <div className={styles.picker}>
          <Button size="md" variant="secondary" icon="paperclip" onClick={() => inputRef.current?.click()}>
            {t('attachments.chooseFiles')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            aria-label={t('attachments.inputLabel')}
            onChange={onChoose}
          />
          <p className={styles.hint}>
            {dragging
              ? t('attachments.dropActive')
              : t('attachments.hint', { max: formatBytes(MAX_ATTACHMENT_BYTES) })}
          </p>
        </div>
      ) : null}

      {uploads.items.length > 0 ? (
        <ul className={styles.list} aria-label={t('attachments.uploading')}>
          {uploads.items.map((item) => (
            <UploadRow
              key={item.id}
              item={item}
              onRetry={() => uploads.retry(item.id)}
              onDismiss={() => uploads.dismiss(item.id)}
            />
          ))}
        </ul>
      ) : null}

      {viewer === null ? null : list.isError && (refused || !list.data) ? (
        <ErrorState compact error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <LoadingState compact />
      ) : attachments.length === 0 ? (
        uploads.items.length === 0 ? (
          <p className={styles.empty}>{t('attachments.none')}</p>
        ) : null
      ) : (
        <ul className={styles.list} aria-label={t('attachments.listLabel')}>
          {attachments.map((attachment) => (
            <AttachmentRow
              key={attachment.id}
              attachment={attachment}
              task={task}
              members={members}
              canDelete={canDeleteAttachment(viewer, task, attachment)}
              onPreview={setPreviewId}
              onDelete={(id) => remove.mutate(id)}
              deleting={remove.isPending && remove.variables === attachment.id}
              deleteError={remove.isError && remove.variables === attachment.id ? remove.error : null}
            />
          ))}
        </ul>
      )}

      <Dialog
        open={previewed !== undefined}
        onClose={() => setPreviewId(null)}
        title={previewed?.fileName ?? ''}
        description={previewed ? formatBytes(previewed.size) : undefined}
        size="lg"
      >
        {previewed ? (
          <img
            className={styles.large}
            src={urls.content(previewed.id)}
            alt={t('attachments.previewOf', { fileName: previewed.fileName })}
          />
        ) : null}
      </Dialog>
    </section>
  );
}

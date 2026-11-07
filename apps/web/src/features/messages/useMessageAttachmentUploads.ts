import { useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, attachmentPreviewOf } from '@projectman/shared';
import type { MessageAttachment } from '@projectman/shared';
import { api } from '../../api/endpoints';
import { isApiError } from '../../api/client';
import { t } from '../../i18n/t';
import { formatBytes, numberFormat } from '../../i18n/format';

/**
 * One file of a tray. `file` is null for a file restored from a draft: its bytes are on the server only, and it
 * is `ready` (or `gone`, once the server says it is no longer there). `gone` has no retry.
 */
export interface AttachmentUpload<A extends { id: string }> {
  id: number;
  file: File | null;
  name: string;
  size: number;
  src?: string;
  status: 'uploading' | 'ready' | 'failed' | 'gone';
  attachment?: A;
}

export interface AttachmentUploadOptions<A extends { id: string }> {
  /** Sends one file; the answer is the stored attachment. */
  upload: (file: File, signal: AbortSignal) => Promise<A>;
  /** Deletes a stored attachment (a removed item, or an upload that finished after the tray was left). */
  remove: (id: string) => Promise<unknown>;
  max: number;
  /** The alert when a file does not fit under `max`. */
  tooManyText: string;
  /** The items the tray starts with (a restored draft); the ids are given here. */
  initial?: () => Omit<AttachmentUpload<A>, 'id'>[];
  /** The tray is left: the files still uploading or failed (the bytes are in the browser only), as failed. */
  onDetach?: (items: AttachmentUpload<A>[]) => void;
}

/** The panel owns its drafts; detached uploads are discarded, while failed sends retain their ids. */
export function useAttachmentUploads<A extends { id: string }>(options: AttachmentUploadOptions<A>) {
  const config = useRef(options);
  config.current = options;
  const nextId = useRef(0);
  const urls = useRef(new Set<string>());
  const starting = useRef<AttachmentUpload<A>[] | null>(null);
  if (starting.current === null)
    starting.current = (options.initial?.() ?? []).map((entry) => {
      // A file the browser still has is previewed from it; a restored one brings its own `src`.
      const src =
        entry.src ??
        (entry.file && attachmentPreviewOf(entry.file.type) === 'image'
          ? URL.createObjectURL(entry.file)
          : undefined);
      if (src && src === entry.src) return { ...entry, id: nextId.current++ };
      if (src) urls.current.add(src);
      return { ...entry, id: nextId.current++, src };
    });
  const [items, setItems] = useState<AttachmentUpload<A>[]>(starting.current);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<AttachmentUpload<A>[]>(starting.current);
  const controllers = useRef(new Map<number, AbortController>());
  const alive = useRef(true);
  const update = (entries: AttachmentUpload<A>[]) => {
    current.current = entries;
    if (alive.current) setItems(entries);
  };
  useEffect(() => {
    alive.current = true;
    const running = controllers.current;
    const previews = urls.current;
    return () => {
      alive.current = false;
      const unfinished = current.current.filter(
        (entry) => entry.file && (entry.status === 'uploading' || entry.status === 'failed'),
      );
      if (unfinished.length)
        config.current.onDetach?.(
          unfinished.map((entry) => ({ ...entry, status: 'failed', src: undefined })),
        );
      for (const controller of running.values()) controller.abort();
      for (const url of previews) URL.revokeObjectURL(url);
      previews.clear();
    };
  }, []);

  const upload = (item: AttachmentUpload<A>) => {
    if (!item.file) return;
    const controller = new AbortController();
    controllers.current.set(item.id, controller);
    void config.current
      .upload(item.file, controller.signal)
      .then(
        (attachment) => {
          if (!alive.current || !current.current.some((entry) => entry.id === item.id)) {
            void config.current.remove(attachment.id).catch(() => undefined);
            return;
          }
          const image = attachmentPreviewOf(item.file?.type ?? '') === 'image';
          if (!image && item.src) {
            URL.revokeObjectURL(item.src);
            urls.current.delete(item.src);
          }
          update(
            current.current.map((entry) =>
              entry.id === item.id
                ? {
                    ...entry,
                    src: image ? entry.src : undefined,
                    status: 'ready',
                    attachment,
                  }
                : entry,
            ),
          );
        },
        () => {
          if (!controller.signal.aborted && alive.current)
            update(
              current.current.map((entry) => (entry.id === item.id ? { ...entry, status: 'failed' } : entry)),
            );
        },
      )
      .finally(() => controllers.current.delete(item.id));
  };
  const add = (files: readonly File[]) => {
    setError(null);
    for (const original of files) {
      if (original.size > MAX_ATTACHMENT_BYTES) {
        const max = formatBytes(MAX_ATTACHMENT_BYTES);
        const roundedSize = formatBytes(original.size);
        // Preserve enough precision to distinguish a file just above the limit.
        const size =
          roundedSize === max
            ? t('attachments.size.megabytes', {
                value: numberFormat({ maximumFractionDigits: 6 }).format(original.size / 1_000_000),
              })
            : roundedSize;
        setError(
          t('messageAttachments.tooLarge', {
            fileName: original.name,
            size,
            max,
          }),
        );
        continue;
      }
      if (current.current.length >= config.current.max) {
        setError(config.current.tooManyText);
        continue;
      }
      const file =
        original.type.startsWith('image/') && (!original.name || original.name === 'image.png')
          ? new File(
              [original],
              t('messageAttachments.pastedName', {
                stamp: new Date().toLocaleString('sv-SE').slice(0, 16).replace(/[ :]/g, '-'),
              }),
              { type: original.type },
            )
          : original;
      const src = attachmentPreviewOf(file.type) === 'image' ? URL.createObjectURL(file) : undefined;
      if (src) urls.current.add(src);
      const item: AttachmentUpload<A> = {
        id: nextId.current++,
        file,
        name: file.name,
        size: file.size,
        src,
        status: 'uploading',
      };
      update([...current.current, item]);
      upload(item);
    }
  };
  const remove = async (id: number) => {
    const item = current.current.find((entry) => entry.id === id);
    if (!item) return false;
    try {
      if (item.attachment) {
        try {
          await config.current.remove(item.attachment.id);
        } catch (error) {
          // A draft whose file is already gone can still be removed after a refused send.
          if (!isApiError(error) || error.status !== 404) throw error;
        }
      }
      controllers.current.get(id)?.abort();
      if (item.src) {
        URL.revokeObjectURL(item.src);
        urls.current.delete(item.src);
      }
      update(current.current.filter((entry) => entry.id !== id));
      setError(null);
      return true;
    } catch {
      setError(t('messageAttachments.deleteFailed'));
      return false;
    }
  };
  const clear = () => {
    for (const item of current.current)
      if (item.src) {
        URL.revokeObjectURL(item.src);
        urls.current.delete(item.src);
      }
    update([]);
    setError(null);
  };
  return {
    items,
    error,
    add,
    remove,
    clear,
    retry: (id: number) => {
      const item = current.current.find((entry) => entry.id === id);
      if (!item || item.status !== 'failed') return;
      update(current.current.map((entry) => (entry.id === id ? { ...entry, status: 'uploading' } : entry)));
      upload(item);
    },
    /** The server refused a send because this file is no longer there: the item is marked, the others stay. */
    markGone: (attachmentId: string) => {
      if (!current.current.some((entry) => entry.attachment?.id === attachmentId)) return;
      update(
        current.current.map((entry) =>
          entry.attachment?.id === attachmentId ? { ...entry, status: 'gone' } : entry,
        ),
      );
    },
    blockedReason: items.some((item) => item.status === 'uploading')
      ? t('messageAttachments.waitUpload')
      : items.some((item) => item.status === 'failed' || item.status === 'gone')
        ? t('messageAttachments.fixFailed')
        : null,
  };
}

/** The tray of a message: one file per request to the message-attachment route. */
export function useMessageAttachmentUploads(projectKey: string) {
  return useAttachmentUploads<MessageAttachment>({
    upload: (file, signal) =>
      api.uploadMessageAttachment(projectKey, file, signal).then(({ attachment }) => attachment),
    remove: (id) => api.deleteMessageAttachment(projectKey, id),
    max: MAX_MESSAGE_ATTACHMENTS,
    tooManyText: t('messageAttachments.tooMany', { max: MAX_MESSAGE_ATTACHMENTS }),
  });
}

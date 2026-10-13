import { useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, attachmentPreviewOf } from '@projectman/shared';
import type { MessageAttachment } from '@projectman/shared';
import { api } from '../../api/endpoints';
import { isApiError } from '../../api/client';
import { t } from '../../i18n/t';
import { formatBytes, LOCALE } from '../../i18n/format';

export interface MessageUpload {
  id: number;
  file: File;
  src?: string;
  status: 'uploading' | 'ready' | 'failed';
  attachment?: MessageAttachment;
}

/** The panel owns its drafts; detached uploads are discarded, while failed sends retain their ids. */
export function useMessageAttachmentUploads(projectKey: string) {
  const [items, setItems] = useState<MessageUpload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<MessageUpload[]>([]);
  const nextId = useRef(0);
  const controllers = useRef(new Map<number, AbortController>());
  const urls = useRef(new Set<string>());
  const alive = useRef(true);
  const update = (entries: MessageUpload[]) => {
    current.current = entries;
    if (alive.current) setItems(entries);
  };
  useEffect(() => {
    alive.current = true;
    const running = controllers.current;
    const previews = urls.current;
    return () => {
      alive.current = false;
      for (const controller of running.values()) controller.abort();
      for (const url of previews) URL.revokeObjectURL(url);
      previews.clear();
    };
  }, []);

  const upload = (item: MessageUpload) => {
    const controller = new AbortController();
    controllers.current.set(item.id, controller);
    void api
      .uploadMessageAttachment(projectKey, item.file, controller.signal)
      .then(
        ({ attachment }) => {
          if (!alive.current || !current.current.some((entry) => entry.id === item.id)) {
            void api.deleteMessageAttachment(projectKey, attachment.id).catch(() => undefined);
            return;
          }
          if (attachment.preview !== 'image' && item.src) {
            URL.revokeObjectURL(item.src);
            urls.current.delete(item.src);
          }
          update(
            current.current.map((entry) =>
              entry.id === item.id
                ? {
                    ...entry,
                    src: attachment.preview === 'image' ? entry.src : undefined,
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
                value: new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 6 }).format(
                  original.size / 1_000_000,
                ),
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
      if (current.current.length >= MAX_MESSAGE_ATTACHMENTS) {
        setError(t('messageAttachments.tooMany', { max: MAX_MESSAGE_ATTACHMENTS }));
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
      const item: MessageUpload = { id: nextId.current++, file, src, status: 'uploading' };
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
          await api.deleteMessageAttachment(projectKey, item.attachment.id);
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
    blockedReason: items.some((item) => item.status === 'uploading')
      ? t('messageAttachments.waitUpload')
      : items.some((item) => item.status === 'failed')
        ? t('messageAttachments.fixFailed')
        : null,
  };
}

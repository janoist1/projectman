import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENT_BYTES } from '@projectman/shared';
import { useUploadAttachment } from '../../api/queries';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';

/** At most this many files travel at once; the rest wait their turn. */
export const UPLOAD_CONCURRENCY = 3;

export interface UploadItem {
  id: number;
  file: File;
  status: 'queued' | 'uploading' | 'failed';
  /** Why the file is not uploaded (set when it failed). */
  error: string | null;
  /** Refused here, before any request: sending it again would change nothing. */
  final: boolean;
}

/**
 * The files being attached to one task: one request per file, a few at a time. A file leaves the
 * queue when the server has it (it then shows in the list); a failed one stays with its reason
 * until it is retried or dismissed, and the files that went through are never sent again. A file over
 * the size limit is refused here; the server's check stays the final one. Requests still running
 * when the section goes away (another task, the drawer closed) are cancelled.
 */
export function useAttachmentUploads(projectKey: string, taskKey: string) {
  const upload = useUploadAttachment(projectKey, taskKey);
  const uploadRef = useRef(upload.mutateAsync);
  uploadRef.current = upload.mutateAsync;
  const [items, setItems] = useState<UploadItem[]>([]);
  const nextId = useRef(0);
  const started = useRef(new Set<number>());
  const controllers = useRef(new Map<number, AbortController>());
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    const running = controllers.current;
    return () => {
      alive.current = false;
      for (const controller of running.values()) controller.abort();
      running.clear();
    };
  }, []);

  const update = useCallback((id: number, patch: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const add = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    setItems((current) => [
      ...current,
      ...files.map((file): UploadItem => {
        const id = nextId.current++;
        return file.size > MAX_ATTACHMENT_BYTES
          ? {
              id,
              file,
              status: 'failed',
              final: true,
              error: t('attachments.tooLarge', {
                size: formatBytes(file.size),
                max: formatBytes(MAX_ATTACHMENT_BYTES),
              }),
            }
          : { id, file, status: 'queued', final: false, error: null };
      }),
    ]);
  }, []);

  const retry = useCallback(
    (id: number) => {
      started.current.delete(id);
      update(id, { status: 'queued', error: null });
    },
    [update],
  );

  const dismiss = useCallback((id: number) => {
    started.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    const active = items.filter((item) => item.status === 'uploading').length;
    const turn = items
      .filter((item) => item.status === 'queued' && !started.current.has(item.id))
      .slice(0, Math.max(0, UPLOAD_CONCURRENCY - active));
    if (turn.length === 0) return;
    for (const item of turn) {
      started.current.add(item.id);
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      uploadRef
        .current({ file: item.file, signal: controller.signal })
        .then(
          () => {
            if (alive.current) setItems((current) => current.filter((entry) => entry.id !== item.id));
          },
          (error: unknown) => {
            if (!alive.current || controller.signal.aborted) return;
            update(item.id, {
              status: 'failed',
              error: t('attachments.uploadFailed', { reason: errorMessage(error) }),
            });
          },
        )
        .finally(() => controllers.current.delete(item.id));
    }
    setItems((current) =>
      current.map((item) =>
        turn.some((next) => next.id === item.id) ? { ...item, status: 'uploading' } : item,
      ),
    );
  }, [items, update]);

  return { items, add, retry, dismiss };
}

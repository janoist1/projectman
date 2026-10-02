import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MAX_ATTACHMENT_BYTES, canUploadAttachment } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { useUploadAttachment } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { useToast } from '../../components/toastContext';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';

/** At most this many files travel at once; the rest wait their turn. */
export const UPLOAD_CONCURRENCY = 3;

export interface UploadItem {
  id: number;
  taskKey: string;
  file: File;
  status: 'queued' | 'uploading' | 'failed';
  /** Why the file is not uploaded (set when it failed), as the person reads it next to the file. */
  error: string | null;
  /** The reason alone, for a notice that names the file itself. */
  reason: string | null;
  /** Refused here, before any request: sending it again would change nothing. */
  final: boolean;
  /** The files dropped together on a card, whose outcome is announced once (none: never announced). */
  batch?: number;
}

export interface AddOptions {
  /** Say how it went when all the files of this call are done (the board has no list to show it in). */
  announce?: boolean;
}

export interface UploadQueue {
  items: readonly UploadItem[];
  add(taskKey: string, files: readonly File[], options?: AddOptions): void;
  retry(id: number): void;
  dismiss(id: number): void;
}

interface Batch {
  open: number;
  attached: string[];
  failed: Array<{ fileName: string; reason: string }>;
}

const UploadsContext = createContext<UploadQueue | null>(null);

/**
 * The files being attached to the tasks of the project: one request per file, a few at a time. The
 * queue lives above the board and the open card, so a file dropped on a card on the board goes on
 * when the card is opened, and a failed one can be retried there. A file leaves the queue when the
 * server has it (it then shows in the list); a failed one stays with its reason until it is retried
 * or dismissed, and the files that went through are never sent again. A file over the size limit is
 * refused here; the server's check stays the final one. Requests still running when the project is
 * left are cancelled; closing the card does not cancel them.
 */
export function AttachmentUploadsProvider({ children }: { children: ReactNode }) {
  const { key } = useProject();
  const upload = useUploadAttachment(key);
  const uploadRef = useRef(upload.mutateAsync);
  uploadRef.current = upload.mutateAsync;
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [items, setItems] = useState<UploadItem[]>([]);
  const nextId = useRef(0);
  const nextBatch = useRef(0);
  const batches = useRef(new Map<number, Batch>());
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

  /** One file of a batch is done: the last one tells how the whole went. */
  const settle = useCallback(
    (batchId: number | undefined, outcome: { attached: string } | { failed: string; reason: string }) => {
      const batch = batchId === undefined ? undefined : batches.current.get(batchId);
      if (!batch) return;
      if ('attached' in outcome) batch.attached.push(outcome.attached);
      else batch.failed.push({ fileName: outcome.failed, reason: outcome.reason });
      batch.open -= 1;
      if (batch.open > 0) return;
      batches.current.delete(batchId!);
      if (batch.attached.length === 1) {
        toastRef.current.show(t('attachments.attached', { fileName: batch.attached[0]! }), 'ok');
      } else if (batch.attached.length > 1) {
        toastRef.current.show(t('attachments.attachedMany', { count: batch.attached.length }), 'ok');
      }
      for (const failure of batch.failed) {
        toastRef.current.show(t('attachments.attachFailed', failure), 'error');
      }
    },
    [],
  );

  const add = useCallback(
    (taskKey: string, files: readonly File[], options: AddOptions = {}) => {
      if (files.length === 0) return;
      const batchId = options.announce ? nextBatch.current++ : undefined;
      if (batchId !== undefined) {
        batches.current.set(batchId, { open: files.length, attached: [], failed: [] });
      }
      const added = files.map((file): UploadItem => {
        const id = nextId.current++;
        if (file.size <= MAX_ATTACHMENT_BYTES) {
          return {
            id,
            taskKey,
            file,
            status: 'queued',
            final: false,
            error: null,
            reason: null,
            batch: batchId,
          };
        }
        const reason = t('attachments.tooLarge', {
          size: formatBytes(file.size),
          max: formatBytes(MAX_ATTACHMENT_BYTES),
        });
        return { id, taskKey, file, status: 'failed', final: true, error: reason, reason, batch: batchId };
      });
      setItems((current) => [...current, ...added]);
      // Refused here, so already done as far as the batch goes.
      for (const item of added) {
        if (item.status === 'failed') settle(item.batch, { failed: item.file.name, reason: item.reason! });
      }
    },
    [settle],
  );

  const retry = useCallback(
    (id: number) => {
      started.current.delete(id);
      // Its batch has been announced: a retry shows its outcome in the list.
      update(id, { status: 'queued', error: null, reason: null, batch: undefined });
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
        .current({ taskKey: item.taskKey, file: item.file, signal: controller.signal })
        .then(
          () => {
            if (!alive.current) return;
            setItems((current) => current.filter((entry) => entry.id !== item.id));
            settle(item.batch, { attached: item.file.name });
          },
          (error: unknown) => {
            if (!alive.current || controller.signal.aborted) return;
            const reason = errorMessage(error);
            update(item.id, {
              status: 'failed',
              error: t('attachments.uploadFailed', { reason }),
              reason,
            });
            settle(item.batch, { failed: item.file.name, reason });
          },
        )
        .finally(() => controllers.current.delete(item.id));
    }
    setItems((current) =>
      current.map((item) =>
        turn.some((next) => next.id === item.id) ? { ...item, status: 'uploading' } : item,
      ),
    );
  }, [items, settle, update]);

  const queue = useMemo<UploadQueue>(() => ({ items, add, retry, dismiss }), [items, add, retry, dismiss]);
  return <UploadsContext.Provider value={queue}>{children}</UploadsContext.Provider>;
}

export function useUploadQueue(): UploadQueue {
  const queue = useContext(UploadsContext);
  if (!queue) throw new Error('useUploadQueue must be used inside <AttachmentUploadsProvider>');
  return queue;
}

/** The files of one task, with the actions on them; `add` takes files for this task. */
export function useAttachmentUploads(taskKey: string) {
  const queue = useUploadQueue();
  const { add } = queue;
  const items = useMemo(() => queue.items.filter((item) => item.taskKey === taskKey), [queue.items, taskKey]);
  const addForTask = useCallback((files: readonly File[]) => add(taskKey, files), [add, taskKey]);
  return { items, add: addForTask, retry: queue.retry, dismiss: queue.dismiss };
}

/** Whether the viewer may attach files to a task: the shared rule, as the server judges it. */
export function useCanAttach(): (task: Task) => boolean {
  const { key, me, myHandle } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  return useCallback(
    (task) => (access && myHandle ? canUploadAttachment({ access, handle: myHandle }, task) : false),
    [access, myHandle],
  );
}

/** How many files of each task are on their way (waiting or sending), by task key. */
export function useUploadingCounts(): ReadonlyMap<string, number> {
  const { items } = useUploadQueue();
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (item.status !== 'failed') counts.set(item.taskKey, (counts.get(item.taskKey) ?? 0) + 1);
    }
    return counts;
  }, [items]);
}

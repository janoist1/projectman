import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { TaskCommentsPage } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';

export type CommentThread = TaskCommentsPage['threads'][number];

/** The most pages a "newer comments" request walks back while it looks for the loaded ones. */
const GAP_PAGES = 10;

/** The threads of `pool` and `incoming`, one per top-level comment (the incoming one wins), oldest first. */
function mergeThreads(pool: readonly CommentThread[], incoming: readonly CommentThread[]): CommentThread[] {
  const byId = new Map(pool.map((thread) => [thread.comment.id, thread]));
  for (const thread of incoming) byId.set(thread.comment.id, thread);
  return [...byId.values()].sort(
    (a, b) =>
      a.comment.createdAt.localeCompare(b.comment.createdAt) || a.comment.id.localeCompare(b.comment.id),
  );
}

/**
 * The card's comment threads (PM-1290), a page at a time: the newest page, or the one holding `around` (a
 * link to a comment), then older ones on request and, after a jump, the newer ones. What was loaded stays
 * when a refresh brings the newest page again, so the list does not lose a thread that fell off its end.
 */
export function useTaskComments(key: string, taskKey: string, around: string | null, enabled: boolean) {
  const client = useQueryClient();
  const base = queryKeys.taskComments(key, taskKey);
  const head = useQuery({
    queryKey: [...base, 'head', around ?? ''],
    queryFn: async () => {
      if (!around) return { page: await api.taskComments(key, taskKey, {}), missing: false };
      try {
        return { page: await api.taskComments(key, taskKey, { around }), missing: false };
      } catch (error) {
        // The comment the link names is not there for this reader: the newest page opens, and says so.
        if (isApiError(error) && error.status === 404)
          return { page: await api.taskComments(key, taskKey, {}), missing: true };
        throw error;
      }
    },
    enabled,
  });
  // After a jump the newest page is read as well, once the reader asks for the newer comments.
  const [live, setLive] = useState(false);
  const tail = useQuery({
    queryKey: [...base, 'tail'],
    queryFn: () => api.taskComments(key, taskKey, {}),
    enabled: enabled && around !== null && live,
  });
  const [pool, setPool] = useState<CommentThread[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [moreError, setMoreError] = useState(false);
  const [loadingMore, setLoadingMore] = useState<'older' | 'newer' | null>(null);

  const headData = head.data?.page;
  const missing = head.data?.missing === true;
  useEffect(() => {
    if (!headData) return;
    setPool((current) => mergeThreads(current, headData.threads));
    setCursor((current) => (current === undefined ? headData.nextBefore : current));
  }, [headData]);
  const tailData = tail.data;
  useEffect(() => {
    if (tailData) setPool((current) => mergeThreads(current, tailData.threads));
  }, [tailData]);

  const loadOlder = useCallback(async () => {
    if (!cursor) return;
    setMoreError(false);
    setLoadingMore('older');
    try {
      const page = await client.fetchQuery({
        queryKey: [...base, 'before', cursor],
        queryFn: () => api.taskComments(key, taskKey, { before: cursor }),
        staleTime: 0,
      });
      setPool((current) => mergeThreads(current, page.threads));
      setCursor(page.nextBefore);
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `base` is rebuilt every render from key and taskKey
  }, [client, cursor, key, taskKey]);

  const loadNewer = useCallback(async () => {
    setMoreError(false);
    setLoadingMore('newer');
    try {
      setLive(true);
      let page = await client.fetchQuery({
        queryKey: [...base, 'tail'],
        queryFn: () => api.taskComments(key, taskKey, {}),
        staleTime: 0,
      });
      let known = new Set(pool.map((thread) => thread.comment.id));
      let merged = mergeThreads(pool, page.threads);
      // A page that shares nothing with what is loaded leaves a gap: walk back until they meet.
      for (let step = 0; step < GAP_PAGES; step += 1) {
        if (page.threads.some((thread) => known.has(thread.comment.id)) || !page.nextBefore) break;
        const before: string = page.nextBefore;
        page = await client.fetchQuery({
          queryKey: [...base, 'before', before],
          queryFn: () => api.taskComments(key, taskKey, { before }),
          staleTime: 0,
        });
        merged = mergeThreads(merged, page.threads);
        known = new Set([...known, ...merged.map((thread) => thread.comment.id)]);
      }
      setPool(merged);
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `base` is rebuilt every render from key and taskKey
  }, [client, key, taskKey, pool]);

  // The newer comments are still to load while the newest page has not been read after a jump.
  const hasNewer = around !== null && !missing && !(live && tail.data);
  return {
    threads: pool,
    /** The comment the link named is not available to the reader; the newest page is shown instead. */
    missing,
    isPending: head.isPending,
    isError: head.isError,
    error: head.error,
    refetch: () => void head.refetch(),
    /** A refresh failed while there is something to show. */
    refreshFailed: (head.isError || tail.isError) && pool.length > 0,
    hasOlder: Boolean(cursor),
    hasNewer,
    loadingMore,
    moreError,
    loadOlder,
    loadNewer,
    /** Whether every comment of the card is loaded (the count on the tab is then exact). */
    complete: !cursor && !hasNewer && head.isSuccess,
  };
}

export type TaskCommentsState = ReturnType<typeof useTaskComments>;

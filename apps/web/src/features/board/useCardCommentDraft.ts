import { useCallback, useSyncExternalStore } from 'react';
import type { CommentAttachmentRef } from '@projectman/shared';

/** A ready, not yet sent file of a draft: enough to show it and to send its id after a reload. */
export type DraftFile = Omit<CommentAttachmentRef, 'gone'>;

/** What is typed in one comment box of a card: the text and the files attached to it (uploaded, not sent). */
export interface CommentDraft {
  text: string;
  attachments: DraftFile[];
}

const EMPTY: CommentDraft = { text: '', attachments: [] };
const STORAGE_PREFIX = 'pm:commentDraft:';

/** The main box of the card; a reply box is named by the id of the comment it answers. */
export const MAIN_DRAFT = 'main';

const cache = new Map<string, Record<string, CommentDraft>>();
const listeners = new Set<() => void>();

const storageKey = (projectKey: string, taskKey: string) => `${STORAGE_PREFIX}${projectKey}:${taskKey}`;

const isDraftFile = (value: unknown): value is DraftFile =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as DraftFile).id === 'string' &&
  typeof (value as DraftFile).fileName === 'string';

function read(projectKey: string, taskKey: string): Record<string, CommentDraft> {
  const key = storageKey(projectKey, taskKey);
  const cached = cache.get(key);
  if (cached) return cached;
  let drafts: Record<string, CommentDraft> = {};
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw) {
      const stored = JSON.parse(raw) as Record<string, Partial<CommentDraft>>;
      drafts = Object.fromEntries(
        Object.entries(stored).map(([slot, draft]) => [
          slot,
          {
            text: typeof draft.text === 'string' ? draft.text : '',
            attachments: Array.isArray(draft.attachments) ? draft.attachments.filter(isDraftFile) : [],
          },
        ]),
      );
    }
  } catch {
    // An unreadable draft is no draft; the box starts empty.
  }
  cache.set(key, drafts);
  return drafts;
}

function write(projectKey: string, taskKey: string, drafts: Record<string, CommentDraft>): void {
  const key = storageKey(projectKey, taskKey);
  cache.set(key, drafts);
  try {
    if (Object.keys(drafts).length === 0) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(drafts));
  } catch {
    // Storage can be unavailable (private mode); the draft then lives as long as the page.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The reply boxes of the card that hold a draft (the slots other than the main box). */
export function replyDraftSlots(projectKey: string, taskKey: string): string[] {
  return Object.keys(read(projectKey, taskKey)).filter((slot) => slot !== MAIN_DRAFT);
}

/** Whether one box of the card holds a draft (the text or a file), read without a hook. */
export function hasCommentDraft(projectKey: string, taskKey: string, slot: string): boolean {
  const draft = read(projectKey, taskKey)[slot];
  return draft !== undefined && (draft.text.trim() !== '' || draft.attachments.length > 0);
}

/** Forgets the drafts held in memory (a test starts from a clean store; the storage is the caller's to clear). */
export function resetCommentDrafts(): void {
  cache.clear();
}

/**
 * The draft of one comment box of a card (PM-1290), kept per card in the session's storage: it survives a
 * change of the view, a background refresh and a reload, and is emptied by a successful send. Every box
 * reading the same card and slot sees the same draft, so a later action that writes on the card writes here.
 * The files are the uploaded ones only: a half-finished upload does not come back after a reload.
 */
export function useCardCommentDraft(projectKey: string, taskKey: string, slot: string = MAIN_DRAFT) {
  const draft = useSyncExternalStore(
    subscribe,
    () => read(projectKey, taskKey)[slot] ?? EMPTY,
    () => EMPTY,
  );
  const update = useCallback(
    (patch: Partial<CommentDraft>) => {
      const drafts = { ...read(projectKey, taskKey) };
      const next = { ...(drafts[slot] ?? EMPTY), ...patch };
      if (next.text === '' && next.attachments.length === 0) delete drafts[slot];
      else drafts[slot] = next;
      write(projectKey, taskKey, drafts);
    },
    [projectKey, taskKey, slot],
  );
  return {
    text: draft.text,
    attachments: draft.attachments,
    setText: useCallback((text: string) => update({ text }), [update]),
    setAttachments: useCallback((attachments: DraftFile[]) => update({ attachments }), [update]),
    clear: useCallback(() => update({ text: '', attachments: [] }), [update]),
  };
}

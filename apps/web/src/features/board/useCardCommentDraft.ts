import { useCallback, useSyncExternalStore } from 'react';

/** What is typed in one comment box of a card: the text and the files attached to it (their attachment ids). */
export interface CommentDraft {
  text: string;
  attachments: string[];
}

const EMPTY: CommentDraft = { text: '', attachments: [] };
const STORAGE_PREFIX = 'pm:commentDraft:';

/** The main box of the card; a reply box is named by the id of the comment it answers. */
export const MAIN_DRAFT = 'main';

const cache = new Map<string, Record<string, CommentDraft>>();
const listeners = new Set<() => void>();
/** The transfer notices, per card: they are read by the main box and gone once it is edited or sent. */
const notices = new Map<string, 'moved' | 'merged'>();
/** The cards whose main box was asked to take the focus after a transfer (it may not be drawn yet). */
const focusRequests = new Set<string>();

const storageKey = (projectKey: string, taskKey: string) => `${STORAGE_PREFIX}${projectKey}:${taskKey}`;

function read(projectKey: string, taskKey: string): Record<string, CommentDraft> {
  const key = storageKey(projectKey, taskKey);
  const cached = cache.get(key);
  if (cached) return cached;
  let drafts: Record<string, CommentDraft> = {};
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw) drafts = JSON.parse(raw) as Record<string, CommentDraft>;
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

/** Forgets the drafts held in memory (a test starts from a clean store; the storage is the caller's to clear). */
export function resetCommentDrafts(): void {
  cache.clear();
  notices.clear();
  focusRequests.clear();
}

/** The most files one comment carries (the server's limit). */
const MAX_DRAFT_ATTACHMENTS = 10;

/** What "Írás a kártyára" did to the main box: it was empty (`moved`), or it already held a draft (`merged`). */
export type DraftTransfer = 'moved' | 'merged';

/**
 * Puts text and attachments typed elsewhere (the project manager's panel) into the main box of the card, without
 * sending (PM-1305). A box that already holds a draft keeps it: the new text follows it and the files join its
 * files. The notice stays until the writer edits or sends the box.
 */
export function transferToCardDraft(
  projectKey: string,
  taskKey: string,
  moved: { text: string; attachments: string[] },
): DraftTransfer {
  const drafts = { ...read(projectKey, taskKey) };
  const existing = drafts[MAIN_DRAFT];
  const had = existing !== undefined && (existing.text !== '' || existing.attachments.length > 0);
  const text = [existing?.text ?? '', moved.text].filter((part) => part.trim() !== '').join('\n\n');
  const attachments = [...new Set([...(existing?.attachments ?? []), ...moved.attachments])].slice(
    0,
    MAX_DRAFT_ATTACHMENTS,
  );
  drafts[MAIN_DRAFT] = { text, attachments };
  const outcome: DraftTransfer = had ? 'merged' : 'moved';
  notices.set(storageKey(projectKey, taskKey), outcome);
  focusRequests.add(storageKey(projectKey, taskKey));
  write(projectKey, taskKey, drafts);
  return outcome;
}

/**
 * Whether the main box of the card is asked to take the focus (a transfer just put a draft in it), and the way to
 * say it did. The box may not be drawn yet when the transfer happens, so the request waits for it.
 */
export function useCardDraftFocus(projectKey: string, taskKey: string) {
  const id = storageKey(projectKey, taskKey);
  const wanted = useSyncExternalStore(
    subscribe,
    () => focusRequests.has(id),
    () => false,
  );
  const done = useCallback(() => {
    if (focusRequests.delete(id)) for (const listener of listeners) listener();
  }, [id]);
  return { wanted, done };
}

/** The notice of the last transfer into the main box of the card, and the way to dismiss it. */
export function useCardDraftNotice(projectKey: string, taskKey: string) {
  const id = storageKey(projectKey, taskKey);
  const notice = useSyncExternalStore(
    subscribe,
    () => notices.get(id) ?? null,
    () => null,
  );
  const dismiss = useCallback(() => {
    if (!notices.delete(id)) return;
    for (const listener of listeners) listener();
  }, [id]);
  return { notice, dismiss };
}

/**
 * The draft of one comment box of a card (PM-1290), kept per card in the session's storage: it survives a
 * change of the view, a background refresh and a reload, and is emptied by a successful send. Every box
 * reading the same card and slot sees the same draft, so a later action that writes on the card writes here.
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
    setAttachments: useCallback((attachments: string[]) => update({ attachments }), [update]),
    clear: useCallback(() => update({ text: '', attachments: [] }), [update]),
  };
}

import type {
  FeedbackAnchor,
  FeedbackMarker,
  FeedbackMarkDetail,
  FeedbackMarkKind,
  FeedbackMarkView,
  FeedbackPerson,
  FeedbackScreenshotUpload,
} from '@projectman/shared';
import { isSamePage, resolveAnchor, tipOf } from './anchor';
import type { Point, Rect, Resolution } from './anchor';
import { ApiFailure, createApi } from './api';
import type { Api } from './api';
import { isWellFormedCode, takeLaunchParams } from './code';
import { safeHttpUrl } from './links';
import type { LaunchParams } from './code';
import { collectEnvironment } from './environment';
import { t } from './i18n';
import { colorOf } from './palette';
import { captureScreenshot } from './screenshot';
import type { ShotHighlight } from './screenshot';
import * as storage from './storage';
import type { StoredSession } from './storage';

/**
 * The state and the flows of the widget (PM-510). The views only render this state and call these
 * actions, so the flows (code exchange, refresh, expiry, sending) are testable without a browser UI.
 */
export type Mode = 'element' | 'point' | 'area';
/** `startError` has a retry; the others are final and end with "Rendben". */
export type NoticeKind = 'startError' | 'badCode' | 'expired' | 'signedOut';

export const MAX_BODY = 4000;
export const COUNTER_FROM = 3800;
const REFRESH_MS = 20_000;
const SHOT_TIMEOUT_MS = 20_000;
const FLASH_MS = 6000;
const OFFLINE_AFTER = 2;

export interface Target {
  kind: FeedbackMarkKind;
  anchor: FeedbackAnchor;
  /** What was marked, for the card ("Pont az oldalon"; for an element its short selector, "button.btn-cart"). */
  label: string;
  /** The marked place in viewport coordinates, for the screenshot's highlight. */
  viewportRect: Rect | null;
  viewportPoint: Point | null;
}

export interface ShotState {
  status: 'pending' | 'ready' | 'failed';
  preview: string | null;
}

export interface Draft {
  target: Target;
  body: string;
  shotEnabled: boolean;
  shot: ShotState;
  sending: boolean;
  error: null | { kind: 'send' } | { kind: 'rate'; minutes: number };
}

export interface ThreadState {
  status: 'loading' | 'ready' | 'error';
  detail: FeedbackMarkDetail | null;
  sending: boolean;
  sendError: boolean;
}

export type Card = { type: 'new' } | { type: 'thread'; markId: string };
export interface Panel {
  tab: 'here' | 'all';
  /** A thread open inside the panel (a mark that has no pin). */
  markId: string | null;
}

export interface State {
  phase: 'off' | 'activating' | 'ready';
  notice: NoticeKind | null;
  session: StoredSession | null;
  marks: Record<string, FeedbackMarkView>;
  markers: FeedbackMarker[];
  me: FeedbackPerson | null;
  loaded: boolean;
  offline: boolean;
  hidden: boolean;
  /** Changes with the address, so views look the marks up again. */
  place: string;
  mode: Mode | null;
  menuOpen: boolean;
  helpOpen: boolean;
  welcomeOpen: boolean;
  panel: Panel | null;
  card: Card | null;
  draft: Draft | null;
  threads: Record<string, ThreadState>;
  /** Marks that appeared since the last list (they get the "pop"). */
  fresh: string[];
  flash: string | null;
}

export interface Deps {
  win: Window;
  /** The origin the widget script came from. */
  base: string;
  projectKey: string;
  fetchImpl?: typeof fetch;
  refreshMs?: number;
  capture?: typeof captureScreenshot;
}

export interface Controller {
  getState(): State;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): void;
  retryStart(): Promise<void>;
  dismissNotice(): void;
  refresh(full?: boolean): Promise<void>;
  // targeting
  beginMode(mode: Mode): void;
  cancelMode(): void;
  chooseTarget(target: Target): void;
  choosePage(): void;
  // new mark
  setBody(body: string): void;
  setShotEnabled(enabled: boolean): void;
  sendMark(): Promise<void>;
  cancelDraft(): void;
  // threads and lists
  openMark(markId: string, options?: { scroll?: boolean }): void;
  closeCard(): void;
  sendComment(markId: string, body: string): Promise<boolean>;
  reloadThread(markId: string): Promise<void>;
  openPanel(): void;
  closePanel(): void;
  setTab(tab: 'here' | 'all'): void;
  panelBack(): void;
  // menu and misc
  toggleMenu(open?: boolean): void;
  toggleHelp(open?: boolean): void;
  toggleHidden(): void;
  logout(): Promise<void>;
  finishWelcome(): void;
  /** One step back: card → panel → menu → mode. Returns whether something was closed. */
  escape(): boolean;
  resolutionOf(mark: { anchor: FeedbackAnchor }): Resolution;
  isOnThisPage(mark: FeedbackMarkView): boolean;
  viewportOf(mark: { anchor: FeedbackAnchor }): Point | null;
  /** The projectman Feedback page, with the mark selected when given. */
  appLink(markId?: string): string | null;
}

const initialState = (hidden: boolean): State => ({
  phase: 'off',
  notice: null,
  session: null,
  marks: {},
  markers: [],
  me: null,
  loaded: false,
  offline: false,
  hidden,
  place: '',
  mode: null,
  menuOpen: false,
  helpOpen: false,
  welcomeOpen: false,
  panel: null,
  card: null,
  draft: null,
  threads: {},
  fresh: [],
  flash: null,
});

const LOCATION_EVENT = 'pm-feedback:location';
const PATCHED = Symbol.for('projectman.feedback.history');

/** Makes `pushState` and `replaceState` announce themselves, so a single-page app's route changes are seen. */
function watchHistory(win: Window): void {
  const history = win.history as History & { [PATCHED]?: boolean };
  if (history[PATCHED]) return;
  history[PATCHED] = true;
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      win.dispatchEvent(new Event(LOCATION_EVENT));
    };
  }
}

const placeOf = (win: Window): string => `${win.location.pathname}${win.location.search}`;

export function createController(deps: Deps): Controller {
  const { win, projectKey } = deps;
  const scope: storage.Scope = { apiOrigin: deps.base, projectKey };
  const capture = deps.capture ?? captureScreenshot;

  let state: State = { ...initialState(storage.isHidden(scope)), place: placeOf(win) };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<State>): void => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const api: Api = createApi({
    base: deps.base,
    token: () => state.session?.token ?? null,
    fetchImpl: deps.fetchImpl,
  });

  // --- run state
  let cursor: string | null = null;
  let failures = 0;
  let refreshing = false;
  let refreshAgain: 'none' | 'incremental' | 'full' = 'none';
  let timer: ReturnType<typeof setInterval> | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  const readHere = new Set<string>();
  let pendingLaunch: LaunchParams | null = null;
  let pendingOpen: string | null = null;
  let shotPromise: Promise<{ upload: FeedbackScreenshotUpload; preview: string } | null> | null = null;
  let draftToken = 0;
  let detached: Array<() => void> = [];

  const reducedMotion = (): boolean => win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  const docSize = () => ({
    width: Math.max(win.document.documentElement.scrollWidth, win.innerWidth),
    height: Math.max(win.document.documentElement.scrollHeight, win.innerHeight),
  });
  const scroll = (): Point => ({ x: win.scrollX, y: win.scrollY });

  const resolutionOf = (mark: { anchor: FeedbackAnchor }): Resolution =>
    resolveAnchor(mark.anchor, win.document, docSize());
  const isOnThisPage = (mark: FeedbackMarkView): boolean => isSamePage(mark.pageUrl, win.location);
  const viewportOf = (mark: { anchor: FeedbackAnchor }): Point | null => {
    const tip = tipOf(resolutionOf(mark), mark.anchor, scroll());
    return tip ? { x: tip.x - win.scrollX, y: tip.y - win.scrollY } : null;
  };

  const flash = (text: string): void => {
    if (flashTimer) clearTimeout(flashTimer);
    set({ flash: text });
    flashTimer = setTimeout(() => set({ flash: null }), FLASH_MS);
  };

  // --- ending a session
  function teardown(): void {
    if (timer) clearInterval(timer);
    timer = null;
    for (const off of detached) off();
    detached = [];
    draftToken++;
    shotPromise = null;
    cursor = null;
    failures = 0;
    pendingOpen = null;
  }

  function deactivate(notice: NoticeKind | null): void {
    teardown();
    state = { ...initialState(state.hidden), place: placeOf(win), notice };
    for (const listener of [...listeners]) listener();
  }

  /** The server or the storage says this browser's session is over. */
  function expire(): void {
    storage.clearSession(scope);
    deactivate('expired');
  }

  const onFailure = (error: unknown): boolean => {
    if (error instanceof ApiFailure && error.unauthorized) {
      expire();
      return true;
    }
    return false;
  };

  // --- loading the marks
  const byId = (marks: FeedbackMarkView[]): Record<string, FeedbackMarkView> =>
    Object.fromEntries(marks.map((mark) => [mark.id, mark]));

  async function refresh(full = false): Promise<void> {
    if (!state.session) return;
    if (refreshing) {
      refreshAgain = full || refreshAgain === 'full' ? 'full' : 'incremental';
      return;
    }
    refreshing = true;
    const wasLoaded = state.loaded;
    try {
      const response = await api.list(full ? null : cursor);
      if (!state.session) return; // ended meanwhile
      cursor = response.cursor;
      failures = 0;
      const marks = full ? byId(response.marks) : { ...state.marks, ...byId(response.marks) };
      const fresh = wasLoaded ? response.marks.filter((m) => !(m.id in state.marks)).map((m) => m.id) : [];
      set({
        marks,
        markers: response.markers,
        me: response.me,
        loaded: true,
        offline: false,
        fresh,
      });
      refreshOpenThread();
      if (!wasLoaded) afterFirstList();
    } catch (error) {
      if (!onFailure(error)) {
        failures++;
        if (failures >= OFFLINE_AFTER && !state.offline) set({ offline: true });
      }
    } finally {
      refreshing = false;
      const again = refreshAgain;
      refreshAgain = 'none';
      if (again !== 'none' && state.session) void refresh(again === 'full');
    }
  }

  /** The open thread grows when its mark changed; its input is left alone (the view keeps it). */
  function refreshOpenThread(): void {
    const id = state.card?.type === 'thread' ? state.card.markId : (state.panel?.markId ?? null);
    if (!id) return;
    const mark = state.marks[id];
    const open = state.threads[id];
    if (mark && open?.detail && open.detail.updatedAt !== mark.updatedAt) void loadThread(id, true);
  }

  async function loadThread(markId: string, silent = false): Promise<void> {
    const current = state.threads[markId];
    if (!silent) {
      set({
        threads: {
          ...state.threads,
          [markId]: { status: 'loading', detail: current?.detail ?? null, sending: false, sendError: false },
        },
      });
    }
    try {
      const detail = await api.detail(markId);
      const kept = state.threads[markId];
      set({
        marks: state.marks[markId]
          ? {
              ...state.marks,
              [markId]: { ...toView(detail), unread: detail.unread && !readHere.has(markId) },
            }
          : state.marks,
        threads: {
          ...state.threads,
          [markId]: {
            status: 'ready',
            detail,
            sending: kept?.sending ?? false,
            sendError: kept?.sendError ?? false,
          },
        },
      });
    } catch (error) {
      if (onFailure(error) || silent) return;
      const kept = state.threads[markId];
      set({
        threads: {
          ...state.threads,
          [markId]: { status: 'error', detail: kept?.detail ?? null, sending: false, sendError: false },
        },
      });
    }
  }

  /** A detail carries everything a list entry does; the list entry drops the thread. */
  function toView(detail: FeedbackMarkDetail): FeedbackMarkView {
    const {
      thread: _thread,
      environment: _environment,
      screenshot: _screenshot,
      canProcess: _p,
      canComment: _c,
      ...view
    } = detail;
    return view;
  }

  // --- starting
  function begin(session: StoredSession): void {
    set({ session, phase: 'ready', notice: null, place: placeOf(win), hidden: storage.isHidden(scope) });
    attach();
    void refresh(true);
  }

  function attach(): void {
    const onVisible = (): void => {
      if (win.document.visibilityState === 'visible') void refresh(false);
    };
    const onPlace = (): void => {
      const place = placeOf(win);
      if (place === state.place) return;
      set({ place, mode: null, card: null, draft: null, panel: null, menuOpen: false });
      void refresh(true);
    };
    const onStorage = (event: StorageEvent): void => {
      // Another tab signed out (or the browser's storage was cleared): this tab switches off the same way.
      if (event.key === null || (event.key === storage.sessionKey(scope) && event.newValue === null)) {
        deactivate('signedOut');
      }
    };
    watchHistory(win);
    win.document.addEventListener('visibilitychange', onVisible);
    win.addEventListener('popstate', onPlace);
    win.addEventListener('hashchange', onPlace);
    win.addEventListener(LOCATION_EVENT, onPlace);
    win.addEventListener('storage', onStorage);
    detached.push(
      () => win.document.removeEventListener('visibilitychange', onVisible),
      () => win.removeEventListener('popstate', onPlace),
      () => win.removeEventListener('hashchange', onPlace),
      () => win.removeEventListener(LOCATION_EVENT, onPlace),
      () => win.removeEventListener('storage', onStorage),
    );
    timer = setInterval(() => {
      if (win.document.visibilityState === 'visible') void refresh(false);
    }, deps.refreshMs ?? REFRESH_MS);
  }

  function afterFirstList(): void {
    pendingOpen = pendingOpen ?? storage.takePendingMark(scope);
    if (state.welcomeOpen) return; // the thread opens after "Kezdjük"
    openPending();
  }

  function openPending(): void {
    const id = pendingOpen;
    pendingOpen = null;
    if (id && state.marks[id]) openMark(id, { scroll: true });
  }

  async function activate(launch: LaunchParams): Promise<void> {
    pendingLaunch = launch;
    set({ phase: 'activating', notice: null });
    let session: StoredSession;
    try {
      session = await api.exchange(launch.code);
    } catch (error) {
      if (error instanceof ApiFailure && error.unauthorized) return invalidCode();
      set({ phase: 'off', notice: 'startError' });
      return;
    }
    if (session.project.key !== projectKey) return invalidCode();
    pendingLaunch = null;
    storage.saveSession(scope, session);
    pendingOpen = session.markId ?? launch.markId;
    const first = !storage.welcomeShown(scope);
    if (first) {
      storage.markWelcomeShown(scope);
      state = { ...state, welcomeOpen: true };
    }
    begin(session);
  }

  /** The code is no use: with a stored session the widget starts silently on it, else it says so. */
  function invalidCode(): void {
    pendingLaunch = null;
    const stored = storage.loadSession(scope);
    if (stored) begin(stored);
    else set({ phase: 'off', notice: 'badCode' });
  }

  async function start(): Promise<void> {
    const launch = takeLaunchParams(win);
    if (launch) {
      if (!isWellFormedCode(launch.code)) return invalidCode();
      return activate(launch);
    }
    const stored = storage.loadSession(scope);
    if (stored) begin(stored);
    // No code and no stored session: nothing is loaded and nothing is requested.
  }

  // --- targeting and the new-mark card
  function beginMode(mode: Mode): void {
    set({ mode, menuOpen: false, panel: null, card: null, draft: null, helpOpen: false });
  }
  const cancelMode = (): void => set({ mode: null });

  function openDraft(target: Target): void {
    const token = ++draftToken;
    const highlight: ShotHighlight | null =
      target.viewportRect || target.viewportPoint
        ? {
            rect: target.viewportRect,
            point: target.viewportPoint,
            color: colorOf(state.me ?? state.session?.me ?? null),
          }
        : null;
    set({
      mode: null,
      panel: null,
      menuOpen: false,
      card: { type: 'new' },
      draft: {
        target,
        body: '',
        shotEnabled: true,
        shot: { status: 'pending', preview: null },
        sending: false,
        error: null,
      },
    });
    // The picture is taken as the card opens, so it is usually ready when the text is.
    shotPromise = Promise.race([
      capture(win, highlight),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SHOT_TIMEOUT_MS)),
    ]);
    void shotPromise.then((result) => {
      if (token !== draftToken || !state.draft) return;
      set({
        draft: {
          ...state.draft,
          shotEnabled: result ? state.draft.shotEnabled : false,
          shot: result ? { status: 'ready', preview: result.preview } : { status: 'failed', preview: null },
        },
      });
    });
  }

  const chooseTarget = (target: Target): void => openDraft(target);

  function choosePage(): void {
    openDraft({
      kind: 'page',
      anchor: {
        kind: 'page',
        selector: null,
        textSnippet: null,
        elementOffset: null,
        pagePoint: null,
        rect: null,
      },
      label: t('new.whatPage'),
      viewportRect: null,
      viewportPoint: null,
    });
  }

  const updateDraft = (patch: Partial<Draft>): void => {
    if (state.draft) set({ draft: { ...state.draft, ...patch } });
  };

  const setBody = (body: string): void =>
    updateDraft({ body, error: state.draft?.sending ? state.draft.error : null });
  const setShotEnabled = (enabled: boolean): void => {
    if (state.draft?.shot.status === 'failed') return;
    updateDraft({ shotEnabled: enabled });
  };

  const pageUrl = (): string => {
    const { origin, pathname, search } = win.location;
    const full = `${origin}${pathname}${search}`;
    return full.length <= 2048 ? full : `${origin}${pathname}`.slice(0, 2048);
  };

  async function sendMark(): Promise<void> {
    const draft = state.draft;
    if (!draft || draft.sending) return;
    const body = draft.body.trim();
    if (body === '' || body.length > MAX_BODY) return;
    updateDraft({ sending: true, error: null });
    const token = draftToken;

    // Sending is allowed while the picture is still being made: it waits for it ("Küldés…").
    let screenshot: FeedbackScreenshotUpload | null = null;
    let withoutShot = false;
    if (draft.shotEnabled) {
      const result = await shotPromise;
      if (token !== draftToken) return;
      screenshot = result?.upload ?? null;
      withoutShot = result === null;
    }
    // A failed picture also switches the switch off, so the branch above was skipped.
    if (state.draft?.shot.status === 'failed') withoutShot = true;

    const request = {
      pageUrl: pageUrl(),
      pageTitle: win.document.title.slice(0, 300),
      kind: draft.target.kind,
      body,
      anchor: draft.target.anchor,
      environment: collectEnvironment(win),
    };
    try {
      let detail: FeedbackMarkDetail;
      try {
        detail = await api.createMark({ ...request, screenshot });
      } catch (error) {
        const code = error instanceof ApiFailure ? error.code : null;
        if (
          screenshot &&
          (code === 'feedback_screenshot_invalid' || code === 'feedback_screenshot_too_large')
        ) {
          withoutShot = true;
          detail = await api.createMark({ ...request, screenshot: null });
        } else throw error;
      }
      if (token !== draftToken) return;
      set({
        marks: { ...state.marks, [detail.id]: toView(detail) },
        fresh: [detail.id],
        card: null,
        draft: null,
      });
      flash(t(withoutShot ? 'notice.sentNoShot' : 'new.sent'));
    } catch (error) {
      if (onFailure(error) || token !== draftToken) return;
      if (error instanceof ApiFailure && error.status === 429) {
        updateDraft({
          sending: false,
          error: { kind: 'rate', minutes: Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60)) },
        });
      } else updateDraft({ sending: false, error: { kind: 'send' } });
    }
  }

  function cancelDraft(): void {
    draftToken++;
    shotPromise = null;
    set({ card: null, draft: null });
  }

  // --- threads and lists
  function openMark(markId: string, options: { scroll?: boolean } = {}): void {
    const mark = state.marks[markId];
    if (!mark) return;
    if (!isOnThisPage(mark)) {
      const url = safeHttpUrl(mark.pageUrl);
      if (!url) return;
      storage.setPendingMark(scope, markId);
      win.location.assign(url);
      return;
    }
    const resolution = resolutionOf(mark);
    const pinned = resolution.place === 'located' && !state.hidden;
    if (pinned && options.scroll !== false) scrollTo(mark);
    set({
      mode: null,
      menuOpen: false,
      draft: null,
      ...(pinned
        ? { card: { type: 'thread', markId } as Card, panel: null }
        : { card: null, panel: { tab: 'here', markId } as Panel }),
    });
    if (mark.unread) {
      // The thread answer may still say "unread" while the read request is on its way.
      readHere.add(markId);
      void api.markRead(markId).then(
        () => {
          const latest = state.marks[markId];
          if (latest) set({ marks: { ...state.marks, [markId]: { ...latest, unread: false } } });
        },
        (error: unknown) => {
          readHere.delete(markId);
          void onFailure(error);
        },
      );
    }
    void loadThread(markId);
  }

  function scrollTo(mark: FeedbackMarkView): void {
    const tip = tipOf(resolutionOf(mark), mark.anchor, scroll());
    if (!tip) return;
    const inView =
      tip.y >= win.scrollY + 80 &&
      tip.y <= win.scrollY + win.innerHeight - 160 &&
      tip.x >= win.scrollX &&
      tip.x <= win.scrollX + win.innerWidth;
    if (inView) return;
    win.scrollTo({
      top: Math.max(0, tip.y - win.innerHeight / 3),
      left: Math.max(0, tip.x - win.innerWidth / 2),
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  }

  const closeCard = (): void => {
    if (state.draft) {
      cancelDraft();
      return;
    }
    set({ card: null });
  };

  async function sendComment(markId: string, body: string): Promise<boolean> {
    const text = body.trim();
    const open = state.threads[markId];
    if (text === '' || text.length > MAX_BODY || !open || open.sending) return false;
    set({ threads: { ...state.threads, [markId]: { ...open, sending: true, sendError: false } } });
    try {
      const detail = await api.comment(markId, text);
      set({
        marks: { ...state.marks, [markId]: toView(detail) },
        threads: {
          ...state.threads,
          [markId]: { status: 'ready', detail, sending: false, sendError: false },
        },
      });
      return true;
    } catch (error) {
      if (onFailure(error)) return false;
      const kept = state.threads[markId];
      if (kept)
        set({ threads: { ...state.threads, [markId]: { ...kept, sending: false, sendError: true } } });
      return false;
    }
  }

  const openPanel = (): void =>
    set({
      panel: { tab: 'here', markId: null },
      card: null,
      draft: null,
      menuOpen: false,
      mode: null,
      helpOpen: false,
    });
  const closePanel = (): void => set({ panel: null });
  const setTab = (tab: 'here' | 'all'): void => {
    if (state.panel) set({ panel: { tab, markId: null } });
  };
  const panelBack = (): void => {
    if (state.panel) set({ panel: { tab: state.panel.tab, markId: null } });
  };

  // --- menu and the rest
  const toggleMenu = (open?: boolean): void =>
    set({ menuOpen: open ?? !state.menuOpen, panel: null, helpOpen: false });
  const toggleHelp = (open?: boolean): void => set({ helpOpen: open ?? !state.helpOpen, menuOpen: false });
  function toggleHidden(): void {
    const hidden = !state.hidden;
    storage.setHidden(scope, hidden);
    set({ hidden, menuOpen: false, card: hidden ? null : state.card });
  }

  async function logout(): Promise<void> {
    const had = state.session;
    set({ menuOpen: false });
    // The storage is cleared first and whatever the request does: the browser is signed out either way.
    storage.clearSession(scope);
    if (had) {
      try {
        await api.logout();
      } catch {
        /* the session may already be gone, or there is no connection */
      }
    }
    deactivate('signedOut');
  }

  function finishWelcome(): void {
    set({ welcomeOpen: false });
    openPending();
  }

  function escape(): boolean {
    if (state.card) {
      closeCard();
      return true;
    }
    if (state.panel?.markId) {
      panelBack();
      return true;
    }
    if (state.panel) {
      closePanel();
      return true;
    }
    if (state.helpOpen) {
      toggleHelp(false);
      return true;
    }
    if (state.menuOpen) {
      toggleMenu(false);
      return true;
    }
    if (state.mode) {
      cancelMode();
      return true;
    }
    return false;
  }

  function appLink(markId?: string): string | null {
    const base = state.session?.appUrl;
    if (!base) return null;
    return markId ? `${base}/${markId}` : base;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    stop: () => teardown(),
    async retryStart() {
      if (pendingLaunch) await activate(pendingLaunch);
    },
    dismissNotice: () => set({ notice: null }),
    refresh,
    beginMode,
    cancelMode,
    chooseTarget,
    choosePage,
    setBody,
    setShotEnabled,
    sendMark,
    cancelDraft,
    openMark,
    closeCard,
    sendComment,
    reloadThread: (markId) => loadThread(markId),
    openPanel,
    closePanel,
    setTab,
    panelBack,
    toggleMenu,
    toggleHelp,
    toggleHidden,
    logout,
    finishWelcome,
    escape,
    resolutionOf,
    isOnThisPage,
    viewportOf,
    appLink,
  };
}

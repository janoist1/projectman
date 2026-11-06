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
import { canShareDisplay, ShareRefused, startShare } from './display-capture';
import type { DisplayShare } from './display-capture';
import { collectEnvironment } from './environment';
import { t } from './i18n';
import { colorOf } from './palette';
import { captureScreenshot, shotFailureLine, shotMissingLine } from './screenshot';
import type { ShotHighlight, ShotOutcome } from './screenshot';
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
  /** Where the picture comes from: the automatic render, or the browser's screen sharing (PM-921). */
  source: 'auto' | 'browser';
  /** A browser picture of a window or a screen: the marked place is not on it. */
  unmarked: boolean;
  /** The last try of the browser picture on this card. */
  browser: 'idle' | 'asking' | 'denied' | 'error';
}

/** A finished picture and where it came from; what the mark is sent with. */
interface Picture {
  outcome: ShotOutcome;
  source: ShotState['source'];
  unmarked: boolean;
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
  /** The delete confirmation is open. */
  deleteAsk?: boolean;
  deleting?: boolean;
  deleteError?: boolean;
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
  /** This browser can share the screen here, so the browser picture is offered. */
  canShare: boolean;
  /** A screen share is open: the pictures come from it. */
  sharing: boolean;
}

export interface Deps {
  win: Window;
  /** The origin the widget script came from. */
  base: string;
  projectKey: string;
  fetchImpl?: typeof fetch;
  refreshMs?: number;
  capture?: typeof captureScreenshot;
  /** The screen-sharing seam (the display-capture module by default). */
  display?: { can(win: Window): boolean; start(win: Window): Promise<DisplayShare> };
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
  /** Takes the picture of the open card with the browser's screen sharing; asks once, then reuses the share. */
  captureWithBrowser(): Promise<void>;
  /** Ends the screen share (the sharing button). */
  stopSharing(): void;
  sendMark(): Promise<void>;
  cancelDraft(): void;
  // threads and lists
  openMark(markId: string, options?: { scroll?: boolean }): void;
  closeCard(): void;
  sendComment(markId: string, body: string): Promise<boolean>;
  reloadThread(markId: string): Promise<void>;
  /** Opens (`true`) or closes the delete confirmation of a mark. */
  askDelete(markId: string, ask: boolean): void;
  deleteMark(markId: string): Promise<void>;
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

const initialState = (hidden: boolean, canShare: boolean): State => ({
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
  canShare,
  sharing: false,
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
  const display = deps.display ?? { can: canShareDisplay, start: startShare };
  // What the browser can do does not change while the page is open.
  const canShare = display.can(win);

  let state: State = { ...initialState(storage.isHidden(scope), canShare), place: placeOf(win) };
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
  let shotPromise: Promise<Picture> | null = null;
  let draftToken = 0;
  /** The picture of the open card: a late automatic result is dropped once the browser picture won. */
  let shotToken = 0;
  /** Changes when the session ends, so a share that was granted meanwhile is stopped at once. */
  let epoch = 0;
  let share: DisplayShare | null = null;
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
    epoch++;
    shotPromise = null;
    share?.stop();
    share = null;
    cursor = null;
    failures = 0;
    pendingOpen = null;
  }

  /** The share ends: the pictures are made automatically again. `notify` says so (not on leaving). */
  function endShare(which: DisplayShare, notify: boolean): void {
    if (share !== which) return;
    share = null;
    which.stop();
    set({ sharing: false });
    if (notify) flash(t('notice.shareStopped'));
  }

  function deactivate(notice: NoticeKind | null): void {
    teardown();
    state = { ...initialState(state.hidden, canShare), place: placeOf(win), notice };
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
          [markId]: {
            ...current,
            status: 'loading',
            detail: current?.detail ?? null,
            sending: false,
            sendError: false,
          },
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
            ...kept,
            status: 'ready',
            detail,
            sending: kept?.sending ?? false,
            sendError: kept?.sendError ?? false,
          },
        },
      });
    } catch (error) {
      if (onFailure(error)) return;
      if (error instanceof ApiFailure && error.status === 404) {
        markGone(markId, 'notice.deletedElsewhere');
        return;
      }
      if (silent) return;
      const kept = state.threads[markId];
      set({
        threads: {
          ...state.threads,
          [markId]: {
            ...kept,
            status: 'error',
            detail: kept?.detail ?? null,
            sending: false,
            sendError: false,
          },
        },
      });
    }
  }

  /** The mark no longer exists: it leaves the pins and the lists, and its open card or thread closes. */
  function markGone(markId: string, notice: 'notice.deleted' | 'notice.deletedElsewhere'): void {
    const { [markId]: _mark, ...marks } = state.marks;
    const { [markId]: _thread, ...threads } = state.threads;
    set({
      marks,
      threads,
      card: state.card?.type === 'thread' && state.card.markId === markId ? null : state.card,
      panel: state.panel?.markId === markId ? { tab: state.panel.tab, markId: null } : state.panel,
    });
    flash(t(notice));
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
    // Leaving the page ends the share without a message: nobody is left to read it.
    const onLeave = (): void => {
      if (share) endShare(share, false);
    };
    watchHistory(win);
    win.addEventListener('pagehide', onLeave);
    win.document.addEventListener('visibilitychange', onVisible);
    win.addEventListener('popstate', onPlace);
    win.addEventListener('hashchange', onPlace);
    win.addEventListener(LOCATION_EVENT, onPlace);
    win.addEventListener('storage', onStorage);
    detached.push(
      () => win.removeEventListener('pagehide', onLeave),
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

  const highlightOf = (target: Target): ShotHighlight | null =>
    target.viewportRect || target.viewportPoint
      ? {
          rect: target.viewportRect,
          point: target.viewportPoint,
          color: colorOf(state.me ?? state.session?.me ?? null),
        }
      : null;

  /** The automatic picture, with a limit on the whole of it. */
  const autoPicture = async (highlight: ShotHighlight | null): Promise<Picture> => ({
    outcome: await Promise.race([
      capture(win, highlight),
      new Promise<ShotOutcome>((resolve) =>
        setTimeout(() => resolve({ ok: false, failure: { kind: 'timeout' } }), SHOT_TIMEOUT_MS),
      ),
    ]),
    source: 'auto',
    unmarked: false,
  });

  /** One picture from the open share; null when it could not be made (the share may be gone). */
  async function sharedPicture(live: DisplayShare, highlight: ShotHighlight | null): Promise<Picture | null> {
    try {
      const { outcome, marked } = await live.grab(win, highlight);
      if (!outcome.ok) return null;
      return { outcome, source: 'browser', unmarked: highlight !== null && !marked };
    } catch {
      return null;
    }
  }

  function openDraft(target: Target): void {
    const token = ++draftToken;
    const picture = ++shotToken;
    const highlight = highlightOf(target);
    set({
      mode: null,
      panel: null,
      menuOpen: false,
      card: { type: 'new' },
      draft: {
        target,
        body: '',
        shotEnabled: true,
        shot: { status: 'pending', preview: null, source: 'auto', unmarked: false, browser: 'idle' },
        sending: false,
        error: null,
      },
    });
    // The picture is taken as the card opens, so it is usually ready when the text is. While a share is
    // open it comes from there; when that fails, the automatic picture is the fallback.
    const live = share;
    shotPromise = (async () =>
      (live ? await sharedPicture(live, highlight) : null) ?? autoPicture(highlight))();
    void shotPromise.then((result) => {
      if (token !== draftToken || picture !== shotToken || !state.draft) return;
      const { outcome } = result;
      // The reason goes to the page's console, once for each picture (PM-920).
      if (!outcome.ok) console.warn(shotFailureLine(outcome.failure));
      else if (outcome.missing.length > 0) console.warn(shotMissingLine(outcome.missing));
      set({
        draft: {
          ...state.draft,
          shotEnabled: outcome.ok ? state.draft.shotEnabled : false,
          shot: {
            ...state.draft.shot,
            status: outcome.ok ? 'ready' : 'failed',
            preview: outcome.ok ? outcome.preview : null,
            source: result.source,
            unmarked: result.unmarked,
          },
        },
      });
    });
  }

  /** Asks for the share once; a refusal says why. The share then stays open until the marking ends. */
  async function ensureShare(): Promise<DisplayShare | 'denied' | 'error'> {
    if (share) return share;
    const mine = epoch;
    let started: DisplayShare;
    try {
      started = await display.start(win);
    } catch (error) {
      return error instanceof ShareRefused ? error.reason : 'error';
    }
    if (mine !== epoch) {
      started.stop(); // the session ended while the browser was asking
      return 'error';
    }
    share = started;
    started.onEnded(() => endShare(started, true));
    set({ sharing: true });
    return started;
  }

  async function captureWithBrowser(): Promise<void> {
    const draft = state.draft;
    if (!draft || draft.sending || draft.shot.browser === 'asking') return;
    const token = draftToken;
    const highlight = highlightOf(draft.target);
    const earlier = shotPromise;
    updateDraft({ shot: { ...draft.shot, browser: 'asking' } });

    const attempt = (async (): Promise<Picture | 'denied' | 'error'> => {
      const live = await ensureShare();
      if (typeof live === 'string') return live;
      return (await sharedPicture(live, highlight)) ?? 'error';
    })();
    // Sending waits for the browser picture and falls back to the earlier one, so it never gets half of it.
    shotPromise = attempt.then(async (result) =>
      typeof result === 'string' ? ((await earlier) ?? autoPicture(highlight)) : result,
    );
    const result = await attempt;
    if (token !== draftToken || !state.draft) return;
    if (typeof result === 'string') {
      updateDraft({ shot: { ...state.draft.shot, browser: result } });
      return;
    }
    shotToken++;
    const { outcome } = result;
    updateDraft({
      shotEnabled: true,
      shot: {
        status: 'ready',
        preview: outcome.ok ? outcome.preview : null,
        source: 'browser',
        unmarked: result.unmarked,
        browser: 'idle',
      },
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
      const outcome = (await shotPromise)?.outcome;
      if (token !== draftToken) return;
      screenshot = outcome?.ok ? outcome.upload : null;
      withoutShot = !outcome?.ok;
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

  /** Opens or closes the delete confirmation of a mark. */
  function askDelete(markId: string, ask: boolean): void {
    const open = state.threads[markId];
    if (!open || open.deleting) return;
    set({ threads: { ...state.threads, [markId]: { ...open, deleteAsk: ask, deleteError: false } } });
  }

  async function deleteMark(markId: string): Promise<void> {
    const open = state.threads[markId];
    if (!open || open.deleting) return;
    set({ threads: { ...state.threads, [markId]: { ...open, deleting: true, deleteError: false } } });
    try {
      await api.deleteMark(markId);
      markGone(markId, 'notice.deleted');
    } catch (error) {
      if (onFailure(error)) return;
      if (error instanceof ApiFailure && error.status === 404) {
        markGone(markId, 'notice.deletedElsewhere');
        return;
      }
      const kept = state.threads[markId];
      if (kept)
        set({ threads: { ...state.threads, [markId]: { ...kept, deleting: false, deleteError: true } } });
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
    const openId = state.card?.type === 'thread' ? state.card.markId : (state.panel?.markId ?? null);
    if (openId && state.threads[openId]?.deleteAsk) {
      askDelete(openId, false);
      return true;
    }
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
    captureWithBrowser,
    stopSharing: () => {
      if (share) endShare(share, true);
    },
    sendMark,
    cancelDraft,
    openMark,
    closeCard,
    sendComment,
    reloadThread: (markId) => loadThread(markId),
    askDelete,
    deleteMark,
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

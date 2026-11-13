import { canCommentOnTask, canCreateTasks } from '@projectman/shared';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate, useMatch, useParams } from 'react-router';
import { isApiError } from '../api/client';
import { useBoard, useConfig, useInbox } from '../api/queries';
import { useProjectSubscription } from '../api/socketHooks';
import { AttachmentUploadsProvider } from '../features/board/attachmentUploads';
import { noBoardFilters } from '../features/board/boardFilters';
import type { BoardFilters } from '../features/board/boardFilters';
import { NewTaskDialog } from '../features/board/NewTaskDialog';
import { ProjectPauseBar } from '../features/pause/PauseBanner';
import { ProjectManagerPanel } from '../features/project-manager/ProjectManagerPanel';
import { ProjectManagerUploadsProvider } from '../features/project-manager/projectManagerUploads';
import { PauseConfirmDialog } from '../features/pause/PauseConfirmDialog';
import { t } from '../i18n/t';
import { useIsMobile, writeStorage } from '../lib/hooks';
import { ProjectContext, useMeContext, useMyOpenInbox, useProjectIndexes } from './contexts';
import type { ProjectContextValue } from './contexts';
import { NotFoundPage } from './NotFoundPage';
import { ConnectionBanner, MobileHeader, NavRail, TabBar, TopBar } from './Shell';
import styles from './Shell.module.css';

/** Everything under /p/:projectKey: navigation, top bar, live subscription, new-task dialog. */
export function ProjectLayout() {
  const { projectKey = '' } = useParams();
  const me = useMeContext();
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const boardIndex = useMatch('/p/:projectKey');
  const boardTask = useMatch('/p/:projectKey/tasks/:taskKey/*');
  const fixedBoard = !isMobile && !!(boardIndex || boardTask);
  // A session fills the phone: its own header replaces the app's (project, search, new task, account)
  // and its back arrow the tab bar.
  // An open conversation (PM-78) does the same: its header has the back arrow to the list.
  const sessionRoute = useMatch('/p/:projectKey/sessions/:sessionId');
  const conversationRoute = useMatch('/p/:projectKey/messages/with/:handle');
  const phoneSession = isMobile && (!!sessionRoute || !!conversationRoute);
  useProjectSubscription(projectKey);
  const board = useBoard(projectKey);
  const inbox = useInbox(projectKey);

  const { members } = useProjectIndexes(projectKey);
  const myHandle = me.handles[projectKey] ?? null;
  const myOpen = useMyOpenInbox(projectKey, myHandle);
  const inboxCount = inbox.data ? myOpen.length : (board.data?.openInboxCount ?? 0);
  const [search, setSearch] = useState('');
  const [newTask, setNewTask] = useState<{ kind: 'task' | 'theme' } | null>(null);
  const [pauseOpen, setPauseOpen] = useState(false);
  // Counts the requests to open the pause bar's details (the project manager's "Folytatás…").
  const [pauseDetailsSignal, setPauseDetailsSignal] = useState(0);
  // The Operator's conversation (PM-429, PM-447): one panel for the whole project, opened from the header.
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [projectManagerChecklistRequest, setProjectManagerChecklistRequest] = useState<{
    id: number;
    focus: boolean;
    intro: boolean;
  } | null>(null);
  const [projectManagerPrefill, setProjectManagerPrefill] = useState<{ text: string; id: number } | null>(
    null,
  );
  const projectManagerTrigger = useRef<HTMLElement | null>(null);
  const projectManagerDraft = useRef('');
  const projectManagerScroll = useRef<{ top: number; stick: boolean } | null>(null);
  // The pause this viewer asked for: its details open by themselves.
  const [requestedPauseId, setRequestedPauseId] = useState<string | null>(null);
  const [themeFilter, setThemeFilter] = useState<string | null>(null);
  const [boardFilters, setBoardFilters] = useState<BoardFilters>(noBoardFilters);
  const access = me.projects.find((project) => project.key === projectKey)?.access;
  // The server gives the configuration to every member; the card's state line needs it (PM-291).
  const readConfig = access !== undefined;
  const config = useConfig(projectKey, readConfig);
  const isOwner = access === 'owner';
  const internal = access === 'owner' || access === 'admin' || access === 'developer';
  const can = useMemo(
    () => ({
      createTasks: internal,
      newCards: config.data ? canCreateTasks(config.data.config, access) : internal,
      manageTeam: access === 'owner' || access === 'admin',
      workInSessions: internal,
      pauseTeam: access === 'owner' || access === 'admin',
      comment: canCommentOnTask(access),
      readConfig,
    }),
    [access, config.data, internal, readConfig],
  );

  useEffect(() => {
    writeStorage('lastProject', projectKey);
    setSearch('');
    setThemeFilter(null);
    setBoardFilters(noBoardFilters);
    setRequestedPauseId(null);
    setProjectManagerOpen(false);
    setProjectManagerPrefill(null);
    setProjectManagerChecklistRequest(null);
    projectManagerDraft.current = '';
    projectManagerScroll.current = null;
  }, [projectKey]);

  // The work queues' way back (PM-1297): the panel opens again where the person left it.
  useEffect(() => {
    if (!location.state?.projectManagerOpen) return;
    setProjectManagerOpen(true);
    const { projectManagerOpen: _, ...rest } = location.state;
    void navigate(location.pathname + location.search + location.hash, { replace: true, state: rest });
  }, [location, navigate]);

  useEffect(() => {
    if (!location.state?.projectManagerChecklist) return;
    setProjectManagerOpen(true);
    setProjectManagerChecklistRequest((previous) => ({
      id: (previous?.id ?? 0) + 1,
      focus: false,
      intro: true,
    }));
    const { projectManagerChecklist: _, ...rest } = location.state;
    void navigate(location.pathname + location.search + location.hash, { replace: true, state: rest });
  }, [location, navigate]);

  const value = useMemo<ProjectContextValue>(
    () => ({
      key: projectKey,
      me,
      myHandle,
      isOwner,
      can,
      search,
      setSearch,
      openPause: () => setPauseOpen(true),
      openPauseDetails: () => setPauseDetailsSignal((count) => count + 1),
      projectManagerOpen,
      projectManagerPrefill,
      projectManagerChecklistRequest,
      openProjectManager: (trigger, prefill, options) => {
        projectManagerTrigger.current = trigger ?? null;
        if (options?.checklist)
          setProjectManagerChecklistRequest((previous) => ({
            id: (previous?.id ?? 0) + 1,
            focus: true,
            intro: false,
          }));
        if (prefill !== undefined)
          setProjectManagerPrefill((previous) => ({ text: prefill, id: (previous?.id ?? 0) + 1 }));
        setProjectManagerOpen(true);
      },
      closeProjectManager: () => {
        setProjectManagerOpen(false);
        setProjectManagerPrefill(null);
        setProjectManagerChecklistRequest(null);
      },
      projectManagerDraft,
      projectManagerScroll,
      openNewTask: (options) => setNewTask({ kind: options?.kind ?? 'task' }),
      themeFilter,
      setThemeFilter,
      boardFilters,
      setBoardFilters,
    }),
    [
      projectKey,
      me,
      myHandle,
      isOwner,
      can,
      search,
      projectManagerOpen,
      projectManagerPrefill,
      projectManagerChecklistRequest,
      themeFilter,
      boardFilters,
    ],
  );

  if (board.isError && isApiError(board.error) && board.error.status === 404) {
    return (
      <div className={styles.shell}>
        <main className={styles.main}>
          <NotFoundPage message={t('app.projectNotFound')} />
        </main>
      </div>
    );
  }

  return (
    <ProjectContext.Provider value={value}>
      {/* Above the board and the open card: a file dropped on a card goes on when the card is opened. */}
      <AttachmentUploadsProvider key={projectKey}>
        <ProjectManagerUploadsProvider key={projectKey} projectKey={projectKey}>
          <div className={clsx(styles.shell, fixedBoard && styles.boardShell)}>
            <a href="#main" className={styles.skip}>
              {t('app.skipToContent')}
            </a>
            {isMobile ? null : <NavRail inboxCount={inboxCount} />}
            <div className={clsx(styles.column, isMobile && !phoneSession && styles.withTabbar)}>
              {phoneSession ? null : isMobile ? (
                <MobileHeader
                  board={board.data}
                  pauseAbove={config.data?.config.team.limits.pauseAbovePlanUsagePercent}
                />
              ) : (
                <TopBar
                  board={board.data}
                  members={members}
                  inboxCount={inboxCount}
                  pauseAbove={config.data?.config.team.limits.pauseAbovePlanUsagePercent}
                />
              )}
              <ConnectionBanner />
              <ProjectPauseBar requestedPauseId={requestedPauseId} openSignal={pauseDetailsSignal} />
              <main id="main" tabIndex={-1} className={clsx(styles.main, fixedBoard && styles.boardMain)}>
                <Outlet />
              </main>
            </div>
            {isMobile && !phoneSession ? <TabBar inboxCount={inboxCount} /> : null}
          </div>
          {myHandle && projectManagerOpen ? (
            <ProjectManagerPanel returnFocusTo={projectManagerTrigger} />
          ) : null}
          <NewTaskDialog
            open={newTask !== null}
            initialKind={newTask?.kind ?? 'task'}
            onClose={() => setNewTask(null)}
          />
          <PauseConfirmDialog
            open={pauseOpen}
            onClose={() => setPauseOpen(false)}
            onRequested={setRequestedPauseId}
          />
        </ProjectManagerUploadsProvider>
      </AttachmentUploadsProvider>
    </ProjectContext.Provider>
  );
}

import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useMatch, useParams } from 'react-router';
import { isApiError } from '../api/client';
import { useBoard, useConfig, useInbox } from '../api/queries';
import { useProjectSubscription } from '../api/socketHooks';
import { AttachmentUploadsProvider } from '../features/board/attachmentUploads';
import { NewTaskDialog } from '../features/board/NewTaskDialog';
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
  const isMobile = useIsMobile();
  const boardIndex = useMatch('/p/:projectKey');
  const boardTask = useMatch('/p/:projectKey/tasks/:taskKey');
  const fixedBoard = !isMobile && !!(boardIndex || boardTask);
  useProjectSubscription(projectKey);
  const board = useBoard(projectKey);
  const inbox = useInbox(projectKey);

  const { members } = useProjectIndexes(projectKey);
  const myHandle = me.handles[projectKey] ?? null;
  const myOpen = useMyOpenInbox(projectKey, myHandle);
  const inboxCount = inbox.data ? myOpen.length : (board.data?.openInboxCount ?? 0);
  const [search, setSearch] = useState('');
  const [newTask, setNewTask] = useState<{ kind: 'task' | 'theme' } | null>(null);
  const [themeFilter, setThemeFilter] = useState<string | null>(null);
  const access = me.projects.find((project) => project.key === projectKey)?.access;
  const config = useConfig(projectKey, access === 'owner' || access === 'admin' || access === 'developer');
  const isOwner = access === 'owner';
  const internal = access === 'owner' || access === 'admin' || access === 'developer';
  const can = useMemo(
    () => ({
      createTasks: internal,
      manageTeam: access === 'owner' || access === 'admin',
      workInSessions: internal,
    }),
    [access, internal],
  );

  useEffect(() => {
    writeStorage('lastProject', projectKey);
    setSearch('');
    setThemeFilter(null);
  }, [projectKey]);

  const value = useMemo<ProjectContextValue>(
    () => ({
      key: projectKey,
      me,
      myHandle,
      isOwner,
      can,
      search,
      setSearch,
      openNewTask: (options) => setNewTask({ kind: options?.kind ?? 'task' }),
      themeFilter,
      setThemeFilter,
    }),
    [projectKey, me, myHandle, isOwner, can, search, themeFilter],
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
        <div className={clsx(styles.shell, fixedBoard && styles.boardShell)}>
          <a href="#main" className={styles.skip}>
            {t('app.skipToContent')}
          </a>
          {isMobile ? null : <NavRail inboxCount={inboxCount} />}
          <div className={clsx(styles.column, isMobile && styles.withTabbar)}>
            {isMobile ? (
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
            <main id="main" tabIndex={-1} className={clsx(styles.main, fixedBoard && styles.boardMain)}>
              <Outlet />
            </main>
          </div>
          {isMobile ? <TabBar inboxCount={inboxCount} /> : null}
        </div>
        <NewTaskDialog
          open={newTask !== null}
          initialKind={newTask?.kind ?? 'task'}
          onClose={() => setNewTask(null)}
        />
      </AttachmentUploadsProvider>
    </ProjectContext.Provider>
  );
}

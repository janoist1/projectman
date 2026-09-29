import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useParams } from 'react-router';
import { isApiError } from '../api/client';
import { useBoard, useConfig, useInbox } from '../api/queries';
import { useProjectSubscription } from '../api/socketHooks';
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
  useProjectSubscription(projectKey);
  const board = useBoard(projectKey);
  const inbox = useInbox(projectKey);
  const config = useConfig(projectKey);
  const { members } = useProjectIndexes(projectKey);
  const myHandle = me.handles[projectKey] ?? null;
  const myOpen = useMyOpenInbox(projectKey, myHandle);
  const inboxCount = inbox.data ? myOpen.length : (board.data?.openInboxCount ?? 0);
  const [search, setSearch] = useState('');
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const access = board.data?.members.find(
    (member) => member.handle === myHandle && member.kind === 'human',
  )?.role;
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
      openNewTask: () => setNewTaskOpen(true),
    }),
    [projectKey, me, myHandle, isOwner, can, search],
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
      <div className={styles.shell}>
        <a href="#main" className={styles.skip}>
          {t('app.skipToContent')}
        </a>
        {isMobile ? null : <NavRail inboxCount={inboxCount} />}
        <div className={clsx(styles.column, isMobile && styles.withTabbar)}>
          {isMobile ? (
            <MobileHeader board={board.data} inboxCount={inboxCount} />
          ) : (
            <TopBar
              board={board.data}
              members={members}
              inboxCount={inboxCount}
              pauseAbove={config.data?.config.team.limits.pauseAbovePlanUsagePercent}
            />
          )}
          <ConnectionBanner />
          <main id="main" tabIndex={-1} className={styles.main}>
            <Outlet />
          </main>
        </div>
        {isMobile ? <TabBar inboxCount={inboxCount} /> : null}
      </div>
      <NewTaskDialog open={newTaskOpen} onClose={() => setNewTaskOpen(false)} />
    </ProjectContext.Provider>
  );
}

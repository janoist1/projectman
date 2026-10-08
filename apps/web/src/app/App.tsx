import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy, useState } from 'react';
import type { ComponentType } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { useProjects } from '../api/queries';
import { createQueryClient } from '../api/queryClient';
import { ErrorState, LoadingState } from '../components/States';
import { ToastProvider } from '../components/Toast';
import { BoardPage } from '../features/board/BoardPage';
import { TaskDrawer } from '../features/board/TaskDrawer';
import { t } from '../i18n/t';
import { readStorage } from '../lib/hooks';
import { AuthGate } from './AuthGate';
import { NotFoundPage } from './NotFoundPage';
import { ProjectLayout } from './ProjectLayout';
import styles from './App.module.css';

/** Route pages other than the board load on demand (keeps the first load small). */
function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  const Page = lazy<ComponentType>(async () => ({ default: (await load())[name] }));
  return (
    <Suspense fallback={<LoadingState />}>
      <Page />
    </Suspense>
  );
}

const invitePage = lazyPage(() => import('../features/invites/AcceptInvitePage'), 'AcceptInvitePage');
const setupPage = lazyPage(() => import('../features/auth/SetupPage'), 'SetupPage');
const loginPage = lazyPage(() => import('../features/auth/LoginPage'), 'LoginPage');
const createProjectPage = lazyPage(
  () => import('../features/projects/CreateProjectPage'),
  'CreateProjectPage',
);
const sessionPage = lazyPage(() => import('../features/session/SessionPage'), 'SessionPage');
const inboxPage = lazyPage(() => import('../features/inbox/InboxPage'), 'InboxPage');
const memberProfilePage = lazyPage(() => import('../features/team/MemberProfilePage'), 'MemberProfilePage');
const mapPage = lazyPage(() => import('../features/map/MapPage'), 'MapPage');
const mapOverview = lazyPage(() => import('../features/map/MapOverview'), 'MapOverview');
const teamPage = lazyPage(() => import('../features/team/TeamPage'), 'TeamPage');
const involvementsPage = lazyPage(() => import('../features/team/InvolvementsPage'), 'InvolvementsPage');
const messagesPage = lazyPage(() => import('../features/messages/MessagesPage'), 'MessagesPage');
const howWeWorkPage = lazyPage(() => import('../features/how-we-work/HowWeWorkPage'), 'HowWeWorkPage');
const settingsPage = lazyPage(() => import('../features/settings/SettingsPage'), 'SettingsPage');

/** "/" → the last visited project, the first project, or project creation. */
function HomeRedirect() {
  const projects = useProjects();
  if (projects.isPending) return <LoadingState className={styles.full} />;
  if (projects.isError)
    return (
      <ErrorState className={styles.full} error={projects.error} onRetry={() => void projects.refetch()} />
    );
  const last = readStorage('lastProject');
  const target = projects.data.find((project) => project.key === last) ?? projects.data[0];
  if (!target) return <Navigate to="/projects/new" replace />;
  return <Navigate to={`/p/${target.key}`} replace />;
}

const notFound = <NotFoundPage message={t('app.notFound')} />;

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/invite/:token" element={invitePage} />
      <Route path="/setup" element={setupPage} />
      <Route path="/login" element={loginPage} />
      <Route element={<AuthGate />}>
        <Route index element={<HomeRedirect />} />
        <Route path="/projects/new" element={createProjectPage} />
        <Route path="/p/:projectKey" element={<ProjectLayout />}>
          <Route element={<BoardPage />}>
            <Route index element={null} />
            {/* The splat lets `…/thread` (the card's conversation view) select the same card. */}
            <Route path="tasks/:taskKey/*" element={<TaskDrawer />} />
          </Route>
          <Route path="sessions/:sessionId" element={sessionPage} />
          <Route path="sessions" element={involvementsPage} />
          <Route path="inbox" element={inboxPage} />
          <Route path="map" element={mapPage}>
            <Route index element={mapOverview} />
          </Route>
          <Route path="team" element={teamPage} />
          <Route path="team/:handle" element={memberProfilePage} />
          <Route path="messages" element={messagesPage} />
          <Route path="messages/with/:handle" element={messagesPage} />
          <Route path="messages/all" element={messagesPage} />
          <Route path="how-we-work" element={howWeWorkPage} />
          <Route path="settings" element={settingsPage} />
          <Route path="settings/:section" element={settingsPage} />
          <Route path="*" element={notFound} />
        </Route>
      </Route>
      <Route path="*" element={notFound} />
    </Routes>
  );
}

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

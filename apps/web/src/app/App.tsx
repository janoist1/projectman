import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy, useState } from 'react';
import type { ComponentType } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { useMe, useProjects } from '../api/queries';
import { createQueryClient } from '../api/queryClient';
import { ErrorState, LoadingState } from '../components/States';
import { ToastProvider } from '../components/Toast';
import { BoardPage } from '../features/board/BoardPage';
import { TaskDrawer } from '../features/board/TaskDrawer';
import { t } from '../i18n/t';
import { useLanguage } from '../i18n/useLanguage';
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
const ownerInvitePage = lazyPage(
  () => import('../features/owner-onboarding/AcceptOwnerInvitePage'),
  'AcceptOwnerInvitePage',
);
const welcomePage = lazyPage(() => import('../features/owner-onboarding/WelcomePage'), 'WelcomePage');
const projectSetupPage = lazyPage(
  () => import('../features/owner-onboarding/ProjectSetupPage'),
  'ProjectSetupPage',
);
const setupPage = lazyPage(() => import('../features/auth/SetupPage'), 'SetupPage');
const loginPage = lazyPage(() => import('../features/auth/LoginPage'), 'LoginPage');
const passwordResetPage = lazyPage(() => import('../features/auth/PasswordResetPage'), 'PasswordResetPage');
const createProjectPage = lazyPage(
  () => import('../features/projects/CreateProjectPage'),
  'CreateProjectPage',
);
const sessionPage = lazyPage(() => import('../features/session/SessionPage'), 'SessionPage');
const inboxPage = lazyPage(() => import('../features/inbox/InboxPage'), 'InboxPage');
const memberProfilePage = lazyPage(() => import('../features/team/MemberProfilePage'), 'MemberProfilePage');
const memberContextPage = lazyPage(() => import('../features/team/MemberContextPage'), 'MemberContextPage');
const mapPage = lazyPage(() => import('../features/map/StructureView'), 'StructureView');
const teamPage = lazyPage(() => import('../features/team/TeamPage'), 'TeamPage');
const involvementsPage = lazyPage(() => import('../features/team/InvolvementsPage'), 'InvolvementsPage');
const messagesPage = lazyPage(() => import('../features/messages/MessagesPage'), 'MessagesPage');
const feedbackPage = lazyPage(() => import('../features/feedback/FeedbackPage'), 'FeedbackPage');
const notificationsPage = lazyPage(
  () => import('../features/notifications/NotificationsPage'),
  'NotificationsPage',
);
const documentsPage = lazyPage(() => import('../features/documents/routes'), 'DocumentsRoute');
const documentPage = lazyPage(() => import('../features/documents/routes'), 'DocumentRoute');
const howWeWorkPage = lazyPage(() => import('../features/how-we-work/HowWeWorkPage'), 'HowWeWorkPage');
const settingsPage = lazyPage(() => import('../features/settings/SettingsPage'), 'SettingsPage');

/** "/" → the last visited project, the first project, the first steps of an owner account, or project creation. */
function HomeRedirect() {
  const projects = useProjects();
  const me = useMe();
  if (projects.isPending || me.isPending) return <LoadingState className={styles.full} />;
  if (projects.isError)
    return (
      <ErrorState className={styles.full} error={projects.error} onRetry={() => void projects.refetch()} />
    );
  const last = readStorage('lastProject');
  const target = projects.data.find((project) => project.key === last) ?? projects.data[0];
  if (!target) return <Navigate to={me.data?.ownerAccount ? '/welcome' : '/projects/new'} replace />;
  return <Navigate to={`/p/${target.key}`} replace />;
}

export function AppRoutes() {
  const notFound = <NotFoundPage message={t('app.notFound')} />;
  return (
    <Routes>
      <Route path="/invite/:token" element={invitePage} />
      <Route path="/owner-invite/:token" element={ownerInvitePage} />
      <Route path="/setup" element={setupPage} />
      <Route path="/login" element={loginPage} />
      <Route path="/login/password" element={passwordResetPage} />
      <Route element={<AuthGate />}>
        <Route index element={<HomeRedirect />} />
        <Route path="/welcome" element={welcomePage} />
        <Route path="/welcome/:projectKey" element={projectSetupPage} />
        <Route path="/projects/new" element={createProjectPage} />
        <Route path="/p/:projectKey" element={<ProjectLayout />}>
          <Route element={<BoardPage />}>
            <Route index element={null} />
            {/* The splat lets `…/thread` (the card's conversation view) select the same card. */}
            <Route path="tasks/:taskKey/*" element={<TaskDrawer />} />
          </Route>
          <Route path="sessions/:sessionId" element={sessionPage} />
          <Route path="sessions" element={involvementsPage} />
          <Route path="inbox" element={inboxPage}>
            {/* The card's drawer over the inbox; the splat selects `…/thread` too. */}
            <Route path="tasks/:taskKey/*" element={<TaskDrawer />} />
          </Route>
          <Route path="map" element={mapPage}>
            <Route path="tasks/:taskKey/*" element={<TaskDrawer />} />
            <Route path=":groupKey/*" element={<Navigate to=".." relative="route" replace />} />
          </Route>
          <Route path="team" element={teamPage} />
          <Route path="team/:handle" element={memberProfilePage} />
          <Route path="team/:handle/context" element={memberContextPage} />
          <Route path="messages" element={messagesPage} />
          <Route path="messages/with/:handle" element={messagesPage} />
          <Route path="messages/all" element={messagesPage} />
          <Route path="feedback" element={feedbackPage} />
          <Route path="feedback/:markId" element={feedbackPage} />
          <Route path="notifications" element={notificationsPage} />
          <Route path="docs" element={documentsPage} />
          <Route path="docs/:slug" element={documentPage} />
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
  const language = useLanguage();
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          {/* A new language remounts the pages (the cache and the route stay): every text is read again. */}
          <AppRoutes key={language} />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

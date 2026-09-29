import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy, useState } from 'react';
import type { ComponentType } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { isApiError } from '../api/client';
import { useProjects } from '../api/queries';
import { ButtonLink } from '../components/Button';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { ToastProvider } from '../components/Toast';
import { BoardPage } from '../features/board/BoardPage';
import { TaskDrawer } from '../features/board/TaskDrawer';
import { t } from '../i18n/t';
import { readStorage } from '../lib/hooks';
import { AuthGate } from './AuthGate';
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

const setupPage = lazyPage(() => import('../features/auth/SetupPage'), 'SetupPage');
const loginPage = lazyPage(() => import('../features/auth/LoginPage'), 'LoginPage');
const createProjectPage = lazyPage(
  () => import('../features/projects/CreateProjectPage'),
  'CreateProjectPage',
);
const sessionPage = lazyPage(() => import('../features/session/SessionPage'), 'SessionPage');
const inboxPage = lazyPage(() => import('../features/inbox/InboxPage'), 'InboxPage');
const teamPage = lazyPage(() => import('../features/team/TeamPage'), 'TeamPage');
const messagesPage = lazyPage(() => import('../features/messages/MessagesPage'), 'MessagesPage');
const settingsPage = lazyPage(() => import('../features/settings/SettingsPage'), 'SettingsPage');

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (count, error) =>
          !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2,
      },
      mutations: { retry: false },
    },
  });
}

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

export function NotFound() {
  return (
    <div className={styles.notFound}>
      <EmptyState
        icon="exclamation"
        title={t('app.notFound')}
        action={
          <ButtonLink to="/" variant="secondary">
            {t('app.backHome')}
          </ButtonLink>
        }
      />
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/setup" element={setupPage} />
      <Route path="/login" element={loginPage} />
      <Route element={<AuthGate />}>
        <Route index element={<HomeRedirect />} />
        <Route path="/projects/new" element={createProjectPage} />
        <Route path="/p/:projectKey" element={<ProjectLayout />}>
          <Route element={<BoardPage />}>
            <Route index element={null} />
            <Route path="tasks/:taskKey" element={<TaskDrawer />} />
          </Route>
          <Route path="sessions/:sessionId" element={sessionPage} />
          <Route path="inbox" element={inboxPage} />
          <Route path="team" element={teamPage} />
          <Route path="messages" element={messagesPage} />
          <Route path="settings" element={settingsPage} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

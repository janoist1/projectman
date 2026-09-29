import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { isApiError } from '../api/client';
import { useProjects } from '../api/queries';
import { ButtonLink } from '../components/Button';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { ToastProvider } from '../components/Toast';
import { LoginPage } from '../features/auth/LoginPage';
import { SetupPage } from '../features/auth/SetupPage';
import { BoardPage } from '../features/board/BoardPage';
import { TaskDrawer } from '../features/board/TaskDrawer';
import { InboxPage } from '../features/inbox/InboxPage';
import { MessagesPage } from '../features/messages/MessagesPage';
import { CreateProjectPage } from '../features/projects/CreateProjectPage';
import { SessionPage } from '../features/session/SessionPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { TeamPage } from '../features/team/TeamPage';
import { t } from '../i18n/t';
import { readStorage } from '../lib/hooks';
import { AuthGate } from './AuthGate';
import { ProjectLayout } from './ProjectLayout';
import styles from './App.module.css';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (count, error) => !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2,
      },
      mutations: { retry: false },
    },
  });
}

/** "/" → the last visited project, the first project, or project creation. */
function HomeRedirect() {
  const projects = useProjects();
  if (projects.isPending) return <LoadingState className={styles.full} />;
  if (projects.isError) return <ErrorState className={styles.full} error={projects.error} onRetry={() => void projects.refetch()} />;
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
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthGate />}>
        <Route index element={<HomeRedirect />} />
        <Route path="/projects/new" element={<CreateProjectPage />} />
        <Route path="/p/:projectKey" element={<ProjectLayout />}>
          <Route element={<BoardPage />}>
            <Route index element={null} />
            <Route path="tasks/:taskKey" element={<TaskDrawer />} />
          </Route>
          <Route path="sessions/:sessionId" element={<SessionPage />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="messages" element={<MessagesPage />} />
          <Route path="settings" element={<SettingsPage />} />
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

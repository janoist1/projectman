import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BoardView,
  CreateProjectRequest,
  CreateTaskRequest,
  HireMemberRequest,
  InboxItem,
  InboxView,
  LoginRequest,
  ResolveInboxRequest,
  RetireMemberRequest,
  SetupRequest,
  StartTaskRequest,
} from '@projectman/shared';
import { isApiError } from './client';
import { countOpenInbox, upsertBy } from './cache';
import { api } from './endpoints';
import { queryKeys } from './queryKeys';

/* ---------- auth ---------- */

export function useSetupStatus() {
  return useQuery({ queryKey: queryKeys.setupStatus, queryFn: api.setupStatus, staleTime: Infinity });
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: api.me,
    enabled,
    staleTime: 5 * 60_000,
    retry: (count, error) => !(isApiError(error) && error.status < 500) && count < 2,
  });
}

export function useSetup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SetupRequest) => api.setup(body),
    onSuccess: async () => {
      client.setQueryData(queryKeys.setupStatus, { needsSetup: false });
      await client.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api.login(body),
    onSuccess: async () => {
      await client.resetQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => {
      client.clear();
    },
  });
}

/* ---------- projects ---------- */

export function useProjects(enabled = true) {
  return useQuery({ queryKey: queryKeys.projects, queryFn: api.projects, enabled });
}

export function useTemplates() {
  return useQuery({ queryKey: queryKeys.templates, queryFn: api.templates, staleTime: Infinity });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) => api.createProject(body),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.projects });
      await client.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/* ---------- board & tasks ---------- */

export function useBoard(key: string) {
  return useQuery({ queryKey: queryKeys.board(key), queryFn: () => api.board(key) });
}

export function useTaskDetail(key: string, taskKey: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.task(key, taskKey ?? ''),
    queryFn: () => api.task(key, taskKey ?? ''),
    enabled: Boolean(taskKey),
  });
}

export function useCreateTask(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskRequest) => api.createTask(key, body),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.board(key) }),
  });
}

export function useStartTask(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskKey, body }: { taskKey: string; body: StartTaskRequest }) =>
      api.startTask(key, taskKey, body),
    onSuccess: async (_data, { taskKey }) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.task(key, taskKey) }),
      ]);
    },
  });
}

/* ---------- members ---------- */

export function useMembers(key: string) {
  return useQuery({ queryKey: queryKeys.members(key), queryFn: () => api.members(key) });
}

export function useHireMember(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: HireMemberRequest) => api.hireMember(key, body),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.members(key) }),
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.config(key) }),
      ]);
    },
  });
}

export function useRetireMember(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ handle, body }: { handle: string; body: RetireMemberRequest }) =>
      api.retireMember(key, handle, body),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.members(key) }),
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.config(key) }),
      ]);
    },
  });
}

/* ---------- sessions ---------- */

export function useSessionDetail(key: string, sessionId: string) {
  return useQuery({
    queryKey: queryKeys.session(key, sessionId),
    queryFn: () => api.session(key, sessionId),
  });
}

export function useSendSessionMessage(key: string, sessionId: string) {
  return useMutation({
    mutationFn: (text: string) => api.sendSessionMessage(key, sessionId, { text }),
  });
}

export function useStopSession(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.stopSession(key, sessionId),
    onSuccess: (_data, sessionId) =>
      client.invalidateQueries({ queryKey: queryKeys.session(key, sessionId) }),
  });
}

/* ---------- messages ---------- */

export function useTeamMessages(key: string) {
  return useQuery({ queryKey: queryKeys.messages(key), queryFn: () => api.teamMessages(key) });
}

/* ---------- inbox ---------- */

export function useInbox(key: string) {
  return useQuery({ queryKey: queryKeys.inbox(key), queryFn: () => api.inbox(key) });
}

export interface ResolveVariables {
  item: InboxItem;
  body: ResolveInboxRequest;
}

/**
 * Resolves an inbox item optimistically: the card leaves the list at once and comes back
 * (with an error) if the server refuses.
 */
export function useResolveInbox(key: string, myHandle: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ item, body }: ResolveVariables) => api.resolveInbox(key, item.id, body),
    onMutate: async ({ item, body }) => {
      await client.cancelQueries({ queryKey: queryKeys.inbox(key) });
      const previous = client.getQueryData<InboxView>(queryKeys.inbox(key));
      const resolved: InboxItem = {
        ...item,
        state: 'resolved',
        resolution: {
          optionId: body.optionId,
          by: myHandle ?? item.assignees[0] ?? item.source,
          at: new Date().toISOString(),
          note: body.note ?? null,
        },
      };
      const next = client.setQueryData<InboxView>(queryKeys.inbox(key), (view) =>
        view ? { items: upsertBy(view.items, resolved, (entry) => entry.id) } : view,
      );
      if (next) {
        client.setQueryData<BoardView>(queryKeys.board(key), (board) =>
          board ? { ...board, openInboxCount: countOpenInbox(next.items, null) } : board,
        );
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(queryKeys.inbox(key), context.previous);
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.inbox(key) });
      await client.invalidateQueries({ queryKey: queryKeys.board(key) });
    },
  });
}

/* ---------- config ---------- */

export function useConfig(key: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.config(key),
    queryFn: () => api.config(key),
    enabled,
    retry: (count, error) => !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2,
  });
}

export function useRevertConfig(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (version: string) => api.revertConfig(key, { version }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.config(key) }),
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.members(key) }),
      ]);
    },
  });
}

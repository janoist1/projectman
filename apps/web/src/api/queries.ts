import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { SESSION_CHAT_WINDOW } from '@projectman/shared';
import type {
  CreateDocumentRequest,
  DeleteDocumentQuery,
  RestoreDocumentRequest,
  UpdateDocumentRequest,
  Task,
  CreateOwnerInviteRequest,
  CreatedOwnerInvitation,
  AnswerHostRequestRequest,
  SetChecklistItemStateRequest,
  CloseFeedbackRequest,
  CreateTaskFromFeedbackRequest,
  CreateTaskFromFeedbackResponse,
  FeedbackCommentRequest,
  FeedbackLaunchRequest,
  FeedbackMarkDetail,
  LinkFeedbackRequest,
  StartMergeRequest,
  PrioritizeMergeRequest,
  StopOrphansRequest,
  AttachmentListResponse,
  BoardView,
  CreateEngineResponse,
  InstancePauseView,
  ProjectPauseView,
  BoardMoveRequest,
  SendTeamMessageRequest,
  PatchConfigRequest,
  CreateInviteRequest,
  AcceptInviteRequest,
  EmailLoginCodeRequest,
  EmailLoginVerifyRequest,
  PasswordCodeRequest,
  PasswordResetRequest,
  CustomRoleRequest,
  UpdateMemberRequest,
  UpdateSessionRequest,
  UpdateTaskRequest,
  TaskCoverRequest,
  CancelTaskRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  HireMemberRequest,
  AddHumanMemberRequest,
  InboxItem,
  InboxView,
  LoginRequest,
  ResolveInboxRequest,
  RenameMemberRequest,
  RetireMemberRequest,
  SessionDetail,
  SetupRequest,
  StartTaskRequest,
  CreateTaskCommentRequest,
  ChangeTaskLabelsRequest,
  LabelView,
} from '@projectman/shared';
import { isApiError } from './client';
import { invalidateAttachments, patchOpenInboxCount, upsertBy, writeTask, writeTaskDetail } from './cache';
import { api } from './endpoints';
import { unsubscribeThisDevice } from '../lib/pushDevice';
import { queryKeys } from './queryKeys';
import type { AllMessagesFilter } from './queryKeys';

/* ---------- auth ---------- */

export function useOwnerInvitations(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.ownerInvitations, queryFn: api.ownerInvitations, enabled });
}
export function useCreateOwnerInvitation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      body,
      onCreated,
    }: {
      body: CreateOwnerInviteRequest;
      onCreated: (created: CreatedOwnerInvitation) => void;
    }) => {
      const created = await api.createOwnerInvitation(body);
      onCreated(created);
      const { path: _path, ...invitation } = created;
      return invitation;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.ownerInvitations }),
  });
}
export function useRevokeOwnerInvitation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.revokeOwnerInvitation,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.ownerInvitations }),
  });
}
export function useOwnerAccounts(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.ownerAccounts, queryFn: api.ownerAccounts, enabled });
}
export function useRevokeOwnerAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.revokeOwnerAccount,
    onSuccess: async () => {
      await Promise.all(
        [queryKeys.ownerAccounts, queryKeys.engines, queryKeys.engineStatus].map((queryKey) =>
          client.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
}
export function useHostRequests(state: 'open' | 'all', enabled: boolean) {
  const client = useQueryClient();
  return useQuery({
    queryKey: queryKeys.hostRequests(state),
    queryFn: async () => {
      const data = await api.hostRequests(state);
      // The navigation polls open requests; refresh the visible history along with its badge.
      if (state === 'open') void client.invalidateQueries({ queryKey: queryKeys.hostRequests('all') });
      return data;
    },
    enabled,
    refetchInterval: state === 'open' ? 60_000 : false,
    refetchIntervalInBackground: false,
  });
}
export function useAnswerHostRequest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AnswerHostRequestRequest }) =>
      api.answerHostRequest(id, body),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.hostRequestsAll }),
  });
}

export function useChecklist(key: string, enabled: boolean) {
  return useQuery({ queryKey: queryKeys.checklist(key), queryFn: () => api.checklist(key), enabled });
}

export function useSetChecklistItemState(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: SetChecklistItemStateRequest }) =>
      api.setChecklistItemState(key, itemId, body),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.checklist(key), data);
    },
  });
}

export function useServerVersion(open: boolean) {
  return useQuery({
    queryKey: queryKeys.serverVersion,
    queryFn: api.serverVersion,
    enabled: open,
    staleTime: 60_000,
  });
}

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
    mutationFn: async () => {
      // This browser leaves the push list while the session is still good (PM-815).
      await unsubscribeThisDevice();
      return api.logout();
    },
    onSettled: () => {
      client.clear();
    },
  });
}

/** The host's own provider logins; `enabled` is off for an owner account, whose providers are its machine's. */
export function useProviders(enabled = true) {
  return useQuery({
    queryKey: queryKeys.providers,
    queryFn: api.providers,
    enabled,
    staleTime: 0,
    refetchInterval: 30_000,
  });
}

/* ---------- projects ---------- */

export function useProjects(enabled = true) {
  return useQuery({ queryKey: queryKeys.projects, queryFn: api.projects, enabled });
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
  return useQuery({
    queryKey: queryKeys.board(key),
    queryFn: () => api.board(key),
  });
}

export function useTaskDetail(key: string, taskKey: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.task(key, taskKey ?? ''),
    queryFn: () => api.task(key, taskKey ?? ''),
    enabled: Boolean(taskKey),
  });
}

/** The record of a closed handoff (PM-342): read when the note window opens. */
export function useTaskHandoff(key: string, taskKey: string, handoffId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.taskHandoff(key, taskKey, handoffId ?? ''),
    queryFn: () => api.taskHandoff(key, taskKey, handoffId ?? ''),
    enabled: enabled && Boolean(handoffId),
    retry: false,
    staleTime: Infinity,
  });
}

export function useCreateTask(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskRequest) => api.createTask(key, body),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.taskDetails(key) }),
      ]);
    },
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

/** The merger starts the merge (or tries a failed or stuck one again); the card, the board and the inbox read again. */
export function useStartMerge(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskKey, body }: { taskKey: string; body?: StartMergeRequest }) =>
      api.startMerge(key, taskKey, body),
    onSuccess: async ({ task }) => {
      writeTask(client, key, task);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.task(key, task.key) }),
        client.invalidateQueries({ queryKey: queryKeys.inbox(key) }),
      ]);
    },
  });
}

/** The merger or an owner puts the card's queued merge at the front of the queue (PM-576). */
export function usePrioritizeMerge(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskKey, body }: { taskKey: string; body: PrioritizeMergeRequest }) =>
      api.prioritizeMerge(key, taskKey, body),
    onSuccess: async ({ task }) => {
      writeTask(client, key, task);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.task(key, task.key) }),
      ]);
    },
  });
}

/* ---------- attachments ---------- */

/** A refusal (task gone, access lost) is final: asking again changes nothing. */
const retryUnlessRefused = (count: number, error: unknown) =>
  !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2;

export function useAttachments(key: string, taskKey: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.attachments(key, taskKey),
    queryFn: () => api.attachments(key, taskKey),
    enabled: enabled && Boolean(taskKey),
    retry: retryUnlessRefused,
  });
}

/** One file per call; calls may run side by side. The new file joins the cached list at once. */
export function useUploadAttachment(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskKey, file, signal }: { taskKey: string; file: File; signal?: AbortSignal }) =>
      api.uploadAttachment(key, taskKey, file, signal),
    onSuccess: ({ attachment }, { taskKey }) => {
      client.setQueryData<AttachmentListResponse>(queryKeys.attachments(key, taskKey), (list) =>
        list ? { attachments: upsertBy(list.attachments, attachment, (entry) => entry.id) } : list,
      );
      invalidateAttachments(client, key, taskKey);
    },
  });
}

/** Chooses or hides the card's cover; the card the server answers with goes into the cache (board and detail). */
export function useSetTaskCover(key: string, taskKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (choice: TaskCoverRequest) => api.setTaskCover(key, taskKey, choice),
    onSuccess: ({ task }) => writeTask(client, key, task),
  });
}

export function useDeleteAttachment(key: string, taskKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteAttachment(key, taskKey, id),
    onSuccess: (_data, id) => {
      client.setQueryData<AttachmentListResponse>(queryKeys.attachments(key, taskKey), (list) =>
        list ? { attachments: list.attachments.filter((entry) => entry.id !== id) } : list,
      );
    },
    // A refusal means the list is not what the screen shows (already gone, rights changed).
    onSettled: () => invalidateAttachments(client, key, taskKey),
  });
}

/* ---------- members ---------- */

export function useMembers(key: string) {
  return useQuery({ queryKey: queryKeys.members(key), queryFn: () => api.members(key) });
}

export function useMemberContext(key: string, handle: string, taskKey?: string, enabled = true) {
  return useQuery({
    queryKey: ['memberContext', key, handle, taskKey ?? null],
    queryFn: () => api.memberContext(key, handle, taskKey),
    enabled,
    retry: (count, error) => !(isApiError(error) && error.status < 500) && count < 2,
  });
}

export function useAddHumanMember(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: AddHumanMemberRequest) => api.addHumanMember(key, body),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.members(key) }),
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.config(key) }),
      ]);
    },
  });
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

/**
 * A session with its chat: the last `SESSION_CHAT_WINDOW` items, or only the last `limit` when asked (a
 * peek). The chat events keep it current (`chat_appended`), so it is never refetched on its own (PM-1116).
 */
export function useSessionDetail(key: string, sessionId: string, limit?: number) {
  return useQuery({
    queryKey:
      limit === undefined ? queryKeys.session(key, sessionId) : queryKeys.sessionTail(key, sessionId, limit),
    queryFn: () => api.session(key, sessionId, { limit: limit ?? SESSION_CHAT_WINDOW }),
    staleTime: Infinity,
    // An engine that is away answers the same until it returns; the page waits for its event, not for retries (PM-316).
    retry: (count, error) =>
      !(
        isApiError(error) &&
        (error.code === 'engine_offline' || (error.status >= 400 && error.status < 500))
      ) && count < 2,
  });
}

/** The chat items before the item `before` (the "Korábbiak" button of a long chat, PM-1116). */
export function useEarlierChat(key: string, sessionId: string) {
  return useMutation({
    mutationFn: (before: string) => api.session(key, sessionId, { limit: SESSION_CHAT_WINDOW, before }),
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
    mutationFn: (input: string | { sessionId: string; note?: string; purpose?: 'assignee_change' }) =>
      typeof input === 'string'
        ? api.stopSession(key, input)
        : api.stopSession(key, input.sessionId, { note: input.note, purpose: input.purpose }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.project(key) }),
        client.invalidateQueries({ queryKey: ['machine'] }),
      ]);
    },
  });
}

export function useMachine({ panel }: { panel: boolean }) {
  const me = useMe();
  return useQuery({
    queryKey: ['machine'],
    queryFn: ({ signal }) => api.machine(panel, signal),
    enabled: me.data?.instanceOwner === true,
    refetchInterval: panel ? 5000 : 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/**
 * The engines every member sees (PM-316): `single` on a one-machine installation. `engine_changed` keeps the
 * list live (see `applyServerEvent`).
 */
export function useEngineStatus() {
  const me = useMe();
  const member = me.data?.hostOwner === true || (me.data?.projects.length ?? 0) > 0;
  return useQuery({
    queryKey: queryKeys.engineStatus,
    queryFn: api.engineStatus,
    enabled: member,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * The owner's list of engines with their hello data and counts (revoked ones too). `pollMs` re-asks while a
 * page waits for a machine: an account without a project gets no `engine_changed` event (PM-1067).
 */
export function useEngines(enabled: boolean, pollMs?: number) {
  return useQuery({
    queryKey: queryKeys.engines,
    queryFn: api.engines,
    enabled,
    retry: false,
    refetchInterval: pollMs,
  });
}

/** The provider logins on an engine's machine; `null` waits (no engine yet, or it is not connected). */
export function useEngineProviders(engineId: string | null, pollMs?: number) {
  return useQuery({
    queryKey: queryKeys.engineProviders(engineId ?? ''),
    queryFn: () => api.engineProviders(engineId!),
    enabled: engineId !== null,
    retry: false,
    staleTime: 0,
    refetchInterval: pollMs,
  });
}

/** "Újraellenőrzés": asks the machine itself (`refresh=1`), then shows its answer. */
export function useRecheckEngineProviders(engineId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.engineProviders(engineId, true),
    onSuccess: (view) => client.setQueryData(queryKeys.engineProviders(engineId), view),
  });
}

/** The project's engines with `holdsProject` (PM-1060); `pollMs` waits for the machine's hello. */
export function useProjectEngines(projectKey: string, pollMs?: number) {
  return useQuery({
    queryKey: queryKeys.projectEngines(projectKey),
    queryFn: () => api.projectEngines(projectKey),
    retry: false,
    refetchInterval: pollMs,
  });
}

function refreshEngines(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.engines }),
    client.invalidateQueries({ queryKey: queryKeys.engineStatus }),
  ]);
}

export function useCreateEngine() {
  const client = useQueryClient();
  return useMutation({
    // The machine key is handed on and shown once: it must not stay in the mutation's result.
    mutationFn: async ({
      name,
      onCreated,
    }: {
      name: string;
      onCreated: (created: CreateEngineResponse) => void;
    }) => {
      const created = await api.createEngine(name);
      onCreated(created);
      return created.engine;
    },
    onSuccess: () => refreshEngines(client),
  });
}

export function useRevokeEngine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeEngine(id),
    onSuccess: () => refreshEngines(client),
    // `engine_revoked` and `engine_not_found` mean the list on screen is out of date.
    onError: () => refreshEngines(client),
  });
}

/** The owner renames an engine; the lists that show its name (the project's engines too) load again. */
export function useRenameEngine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameEngine(id, name),
    onSuccess: () =>
      Promise.all([
        refreshEngines(client),
        client.invalidateQueries({ queryKey: queryKeys.projectEnginesAll }),
      ]),
  });
}

function refreshProjectEngines(client: QueryClient, projectKey: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.projectEngines(projectKey) }),
    client.invalidateQueries({ queryKey: queryKeys.engineStatus }),
  ]);
}

/** Binds an engine to the project (PM-1060); `isDefault` makes it the project's base engine as well. */
export function useBindProjectEngine(projectKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ engineId, isDefault }: { engineId: string; isDefault: boolean }) =>
      api.bindProjectEngine(projectKey, engineId, isDefault),
    onSuccess: () => refreshProjectEngines(client, projectKey),
    // `engine_revoked` and `engine_not_owned` mean the list on screen is out of date.
    onError: () => refreshProjectEngines(client, projectKey),
  });
}

export function useUnbindProjectEngine(projectKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (engineId: string) => api.unbindProjectEngine(projectKey, engineId),
    onSuccess: () => refreshProjectEngines(client, projectKey),
    onError: () => refreshProjectEngines(client, projectKey),
  });
}

export function useSetDefaultEngine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.defaultEngine(id),
    onSuccess: (engines) => {
      client.setQueryData(queryKeys.engines, engines);
      return refreshEngines(client);
    },
    onError: () => refreshEngines(client),
  });
}

export function useStopOrphans() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: StopOrphansRequest) => api.stopOrphans(body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['machine'] }),
  });
}

/** An owner's permission settings for one session (PM-170): the answer is the session, written at once. */
export function useUpdateSession(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, body }: { sessionId: string; body: UpdateSessionRequest }) =>
      api.updateSession(key, sessionId, body),
    onSuccess: (session) =>
      client.setQueriesData<SessionDetail>({ queryKey: queryKeys.session(key, session.id) }, (detail) =>
        detail ? { ...detail, session } : detail,
      ),
  });
}

/* ---------- messages ---------- */

export function useTeamMessages(key: string) {
  return useQuery({ queryKey: queryKeys.messages(key), queryFn: () => api.teamMessages(key) });
}

/* ---------- e-mail channel (PM-942) ---------- */

export function useEmailChannel(key: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.emailChannel(key),
    queryFn: () => api.emailChannel(key),
    enabled,
    retry: false,
  });
}

/** The log, a page at a time: `fetchNextPage` is the "Korábbiak" button. */
export function useEmailLog(key: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.emailLog(key),
    queryFn: ({ pageParam }) => api.emailLog(key, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    retry: false,
  });
}

export function useSetEmailContact(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ handle, wants }: { handle: string; wants: boolean }) =>
      api.setEmailContact(key, handle, { wants }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.emailChannel(key) });
      void client.invalidateQueries({ queryKey: queryKeys.emailLog(key) });
    },
  });
}

/* ---------- feedback marks (PM-511) ---------- */

export function useFeedbackList(key: string) {
  return useQuery({ queryKey: queryKeys.feedbackList(key), queryFn: () => api.feedback(key) });
}

/** The badge numbers of the menu item; `enabled` is false for a viewer who has nothing to do with marks. */
export function useFeedbackSummary(key: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.feedbackSummary(key),
    queryFn: () => api.feedbackSummary(key),
    enabled,
    retry: false,
  });
}

export function useFeedbackSettings(key: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.feedbackSettings(key),
    queryFn: () => api.feedbackSettings(key),
    enabled,
    retry: false,
  });
}

/** The marks that led to one card, as the viewer may see them. */
export function useFeedbackOfTask(key: string, taskKey: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.feedbackOfTask(key, taskKey),
    queryFn: () => api.feedback(key, taskKey),
    enabled,
    retry: false,
  });
}

export function useFeedbackMark(key: string, markId: string | null) {
  return useQuery({
    queryKey: queryKeys.feedbackMark(key, markId ?? ''),
    queryFn: () => api.feedbackMark(key, markId ?? ''),
    enabled: Boolean(markId),
    retry: (count, error) => !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2,
  });
}

/** A mutation of a mark: its answer is the mark as it is now, and every feedback list reads again. */
function useFeedbackMutation<
  T,
  R extends FeedbackMarkDetail | CreateTaskFromFeedbackResponse = FeedbackMarkDetail,
>(key: string, mutationFn: (variables: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (result) => {
      const mark: FeedbackMarkDetail = 'mark' in result ? result.mark : result;
      client.setQueryData(queryKeys.feedbackMark(key, mark.id), mark);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.feedback(key) }),
        // A new card or a link shows on the board and on the card's own drawer.
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.taskDetails(key) }),
      ]);
    },
    // The mark moved on under the person (a card was made, it was closed): the open view reads it again.
    onError: (error) => {
      if (isApiError(error) && error.status === 409) {
        void client.invalidateQueries({ queryKey: queryKeys.feedback(key) });
      }
    },
  });
}

export function useCommentFeedback(key: string, markId: string) {
  return useFeedbackMutation(key, (body: FeedbackCommentRequest) => api.feedbackComment(key, markId, body));
}
export function useCreateTaskFromFeedback(key: string, markId: string) {
  return useFeedbackMutation(key, (body: CreateTaskFromFeedbackRequest) =>
    api.feedbackCreateTask(key, markId, body),
  );
}
export function useLinkFeedback(key: string, markId: string) {
  return useFeedbackMutation(key, (body: LinkFeedbackRequest) => api.feedbackLink(key, markId, body));
}
export function useCloseFeedback(key: string, markId: string) {
  return useFeedbackMutation(key, (body: CloseFeedbackRequest) => api.feedbackClose(key, markId, body));
}
export function useReopenFeedback(key: string, markId: string) {
  return useFeedbackMutation<void>(key, () => api.feedbackReopen(key, markId));
}

/**
 * Deletes a mark. The answer says whether it was already gone (someone else deleted it first): that is
 * the same end state, so the view treats it as done with a different notice.
 */
export function useDeleteFeedback(key: string, markId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ alreadyGone: boolean }> => {
      try {
        await api.feedbackDelete(key, markId);
        return { alreadyGone: false };
      } catch (error) {
        if (isApiError(error) && error.status === 404) return { alreadyGone: true };
        throw error;
      }
    },
    onSuccess: async () => {
      client.removeQueries({ queryKey: queryKeys.feedbackMark(key, markId) });
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.feedback(key) }),
        // The card keeps its own line about the deletion.
        client.invalidateQueries({ queryKey: queryKeys.taskDetails(key) }),
      ]);
    },
  });
}

/** The viewer has read the thread of a mark: the unread dot and the badge come off. */
export function useReadFeedback(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (markId: string) => api.feedbackRead(key, markId),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.feedback(key) }),
  });
}

export function useLaunchFeedback(key: string) {
  return useMutation({ mutationFn: (body: FeedbackLaunchRequest) => api.feedbackLaunch(key, body) });
}

export function useLogoutFeedbackMarker(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) => api.feedbackMarkerLogout(key, handle),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.feedbackSettings(key) }),
  });
}

/* ---------- inbox ---------- */

/** The items that have not ended (open, screening): every one of them, however old (they are what waits for someone). */
export function useInbox(key: string) {
  return useQuery({ queryKey: queryKeys.inbox(key), queryFn: () => api.inbox(key) });
}

/** How many closed items the history lists read. */
const INBOX_HISTORY_LIMIT = 200;

/** The newest closed items: "recently decided" on the inbox page, "you answered" in a conversation. */
export function useInboxHistory(key: string) {
  return useQuery({
    queryKey: queryKeys.inboxHistory(key),
    queryFn: () => api.inboxHistory(key, INBOX_HISTORY_LIMIT),
  });
}

/**
 * The questions the Operator screened today (PM-561): the trail "Az Operátor intézte". `enabled` is false for
 * a viewer who may not see it (below admin); `since` is the start of the viewer's day, an ISO time.
 */
export function useScreenedQuestions(key: string, since: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.screenedQuestions(key, since),
    queryFn: () => api.screenedQuestions(key, since),
    enabled,
  });
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
      // Knowledge approval must remain pending until the server records the agreement.
      if (item.payload.operatorKnowledge) return { previous };
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
      if (next) patchOpenInboxCount(client, key, next);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(queryKeys.inbox(key), context.previous);
    },
    onSettled: async (_data, _error, { item }) => {
      await client.invalidateQueries({ queryKey: queryKeys.inbox(key) });
      await client.invalidateQueries({ queryKey: queryKeys.inboxHistory(key) });
      await client.invalidateQueries({ queryKey: queryKeys.board(key) });
      if (item.payload.operatorKnowledge) {
        await client.invalidateQueries({ queryKey: queryKeys.operatorKnowledge(key) });
        await client.invalidateQueries({ queryKey: queryKeys.projectManager(key) });
      }
      // A merge request starts the merge: the open card shows it at once.
      if (item.kind === 'merge_request' && item.taskKey)
        await client.invalidateQueries({ queryKey: queryKeys.task(key, item.taskKey) });
    },
  });
}

/**
 * "Check now" on an outage alert: the server checks again at once. The answer holds the item as it is
 * now (closed when the outage is over); it replaces the one in the list.
 */
export function useCheckOutage(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api.checkOutage(key, itemId),
    onSuccess: (response) => {
      const next = client.setQueryData<InboxView>(queryKeys.inbox(key), (view) =>
        view ? { items: upsertBy(view.items, response.item, (entry) => entry.id) } : view,
      );
      if (next) patchOpenInboxCount(client, key, next);
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

export function usePatchConfig(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchConfigRequest) => api.patchConfig(key, body),
    onSuccess: async (view) => {
      client.setQueryData(queryKeys.config(key), view);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.roles(key) }),
        client.invalidateQueries({ queryKey: queryKeys.projects }),
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
      ]);
    },
  });
}

export function useRevertConfig(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (version: string) => api.revertConfig(key, { version }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.config(key) }),
        client.invalidateQueries({ queryKey: queryKeys.roles(key) }),
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.members(key) }),
      ]);
    },
  });
}

export function useRoles(key: string) {
  return useQuery({ queryKey: queryKeys.roles(key), queryFn: () => api.roles(key) });
}

/** Configuration changes can affect roles, the roster and board at once. */
function useProjectMutation<T, R>(key: string, mutationFn: (body: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.project(key) }),
  });
}

/**
 * Not awaiting the refresh: the page moves to the new handle's profile first, so the old one is never shown
 * as missing (PM-1026).
 */
export function useRenameMember(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ handle, body }: { handle: string; body: RenameMemberRequest }) =>
      api.renameMember(key, handle, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.project(key) });
    },
  });
}
export function useUpdateMember(key: string) {
  return useProjectMutation(key, ({ handle, body }: { handle: string; body: UpdateMemberRequest }) =>
    api.updateMember(key, handle, body),
  );
}
export function useSaveRole(key: string) {
  return useProjectMutation(key, ({ id, body }: { id?: string; body: CustomRoleRequest }) =>
    id ? api.updateRole(key, id, body) : api.createRole(key, body),
  );
}
export function useDeleteRole(key: string) {
  return useProjectMutation(key, (id: string) => api.deleteRole(key, id));
}
/**
 * A change of one card: the server answers with the changed task, which is written to the board and the card,
 * and the card's detail is read again (its timeline and rounds changed). The rest of the project follows by
 * the socket events, not by a refetch of everything (PM-1109).
 */
function useTaskMutation<T, R extends Task>(key: string, mutationFn: (variables: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (task) => {
      writeTask(client, key, task);
      await client.invalidateQueries({ queryKey: queryKeys.task(key, task.key) });
    },
  });
}
export function useUpdateTask(key: string) {
  return useTaskMutation(key, ({ taskKey, body }: { taskKey: string; body: UpdateTaskRequest }) =>
    api.updateTask(key, taskKey, body),
  );
}
/** The server answers with the task's detail: write it instead of refetching the project. */
export function useCreateTaskComment(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskKey, body }: { taskKey: string; body: CreateTaskCommentRequest }) =>
      api.createTaskComment(key, taskKey, body),
    onSuccess: async (detail) => {
      writeTaskDetail(client, key, detail);
      // Mentions message the mentioned members.
      await client.invalidateQueries({ queryKey: queryKeys.messages(key) });
    },
  });
}
export function useChangeTaskLabels(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskKey, body }: { taskKey: string; body: ChangeTaskLabelsRequest }) =>
      api.changeTaskLabels(key, taskKey, body),
    onSuccess: (detail) => writeTaskDetail(client, key, detail),
  });
}

/** The project's label vocabulary (with who may set each label), from the board. */
export function useLabels(key: string): LabelView[] {
  return useBoard(key).data?.labels ?? EMPTY_LABELS;
}
const EMPTY_LABELS: LabelView[] = [];
export function useCancelTask(key: string) {
  return useTaskMutation(key, ({ taskKey, body }: { taskKey: string; body: CancelTaskRequest }) =>
    api.cancelTask(key, taskKey, body),
  );
}
/** Closes a theme; the cards that belong to it are not touched (PM-192). */
export function useCloseTheme(key: string) {
  return useTaskMutation(key, (taskKey: string) => api.closeTheme(key, taskKey));
}
export function useReopenTask(key: string) {
  return useTaskMutation(key, (taskKey: string) => api.reopenTask(key, taskKey));
}

/** Refresh even after approval_requested: the task waits and new inbox decisions exist. */
export function useMoveTask(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskKey,
      stageId,
      despitePrerequisites,
    }: {
      taskKey: string;
      stageId: string;
      /** A person moves the card after the warning that a prerequisite is open (PM-204). */
      despitePrerequisites?: boolean;
    }) =>
      api.updateTask(key, taskKey, { stageId, ...(despitePrerequisites ? { despitePrerequisites } : {}) }),
    onSettled: async (_data, _error, { taskKey }) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.task(key, taskKey) }),
        client.invalidateQueries({ queryKey: queryKeys.inbox(key) }),
      ]);
    },
  });
}

/**
 * A card dropped on the board (PM-118): the server computes the place from the anchor and answers 409
 * `board_stale` when the picture the drop was made on no longer holds. Refreshes even then, so the board
 * shows what it is now.
 */
export function useBoardMove(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskKey, ...body }: { taskKey: string } & BoardMoveRequest) =>
      api.boardMoveTask(key, taskKey, body),
    onSettled: async (_data, _error, { taskKey }) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.task(key, taskKey) }),
        client.invalidateQueries({ queryKey: queryKeys.inbox(key) }),
      ]);
    },
  });
}

/* ---------- schedules ---------- */

export function useSchedules(key: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.schedules(key),
    queryFn: () => api.schedules(key),
    refetchInterval: 60_000,
    enabled,
  });
}

export function useRunSchedule(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) => api.runSchedule(key, handle),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.schedules(key) }),
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.members(key) }),
      ]);
    },
  });
}

/* ---------- pause (PM-220) ---------- */

/** The answer of a project's pause route goes straight into the board: every screen shows it at once. */
function writeProjectPause(client: QueryClient, key: string, pause: ProjectPauseView): void {
  client.setQueryData<BoardView>(queryKeys.board(key), (board) => (board ? { ...board, pause } : board));
}

export function usePauseProject(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.pauseProject(key),
    onSuccess: (pause) => writeProjectPause(client, key, pause),
  });
}

export function useResumeProject(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.resumeProject(key),
    onSuccess: (pause) => writeProjectPause(client, key, pause),
  });
}

export function useForcePauseProject(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.forcePauseProject(key),
    onSuccess: (pause) => writeProjectPause(client, key, pause),
  });
}

/**
 * The instance's pause: the sessions it holds and whether the viewer may resume it. A project page asks
 * only while the instance is paused (`enabled`); a page outside the projects has no websocket and polls.
 */
export function useInstancePause(enabled: boolean, poll = false) {
  return useQuery({
    queryKey: queryKeys.instancePause,
    queryFn: api.instancePause,
    enabled,
    retry: false,
    refetchInterval: poll ? 15_000 : false,
  });
}

/** The answer goes into the instance's view; the open boards carry the instance's pause too. */
function writeInstancePause(client: QueryClient, view: InstancePauseView): void {
  client.setQueryData<InstancePauseView>(queryKeys.instancePause, view);
  void client.invalidateQueries({
    predicate: (query) => query.queryKey[0] === 'project' && query.queryKey[2] === 'board',
  });
}

export function useResumeInstance() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.resumeInstance,
    onSuccess: (view) => writeInstancePause(client, view),
  });
}

export function useForcePauseInstance() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.forcePauseInstance,
    onSuccess: (view) => writeInstancePause(client, view),
  });
}

/* ---------- invitations ---------- */
export function useInvitations(key: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.invitations(key),
    queryFn: () => api.invitations(key),
    enabled,
    refetchInterval: 60_000,
  });
}
export function useCreateInvite(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInviteRequest) => api.createInvite(key, body),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.invitations(key) }),
  });
}
export function useRevokeInvite(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeInvite(key, id),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.invitations(key) }),
  });
}
export function useInvite(token: string) {
  return useQuery({
    queryKey: queryKeys.invite(token),
    queryFn: () => api.invite(token),
    retry: false,
    staleTime: 0,
  });
}
export function useAcceptInvite(token: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: AcceptInviteRequest) => api.acceptInvite(token, body),
    onSuccess: (me) => {
      client.clear();
      client.setQueryData(queryKeys.me, me);
    },
  });
}

export function useOwnerInvite(token: string) {
  return useQuery({
    queryKey: queryKeys.ownerInvite(token),
    queryFn: () => api.ownerInvite(token),
    retry: false,
    staleTime: 0,
  });
}
export function useAcceptOwnerInvite(token: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: AcceptInviteRequest) => api.acceptOwnerInvite(token, body),
    onSuccess: (me) => {
      client.clear();
      client.setQueryData(queryKeys.me, me);
    },
  });
}

/* ---------- e-mail login of invited clients (PM-671) ---------- */

export function useRequestEmailLoginCode() {
  return useMutation({ mutationFn: (body: EmailLoginCodeRequest) => api.requestEmailLoginCode(body) });
}

/** A redeemed code starts the session like an accepted invitation does: a fresh cache with `Me`. */
export function useVerifyEmailLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: EmailLoginVerifyRequest) => api.verifyEmailLogin(body),
    onSuccess: (me) => {
      client.clear();
      client.setQueryData(queryKeys.me, me);
    },
  });
}

/* ---------- password set or reset with an e-mail code (PM-946) ---------- */

export function useRequestPasswordCode() {
  return useMutation({ mutationFn: (body: PasswordCodeRequest) => api.requestPasswordCode(body) });
}

/** A redeemed password code starts a session like a login: a fresh cache with `Me`. */
export function useResetPassword() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PasswordResetRequest) => api.resetPassword(body),
    onSuccess: (me) => {
      client.clear();
      client.setQueryData(queryKeys.me, me);
    },
  });
}

/** The cards closed in the last `days` days with their rounds and tokens (PM-222). */
export function useClosedCardsMeasure(key: string, days: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.closedCards(key, days),
    queryFn: () => api.closedCardsMeasure(key, days),
    enabled,
  });
}

export function useMemberProfile(key: string, handle: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.profile(key, handle),
    queryFn: () => api.memberProfile(key, handle),
    enabled,
  });
}
export function useMemberMemories(key: string, handle: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.memories(key, handle),
    queryFn: () => api.memberMemories(key, handle),
    enabled,
  });
}
export function useStartConversation(key: string) {
  return useProjectMutation(key, (handle: string) => api.startConversation(key, handle));
}
export function useRemoveHuman(key: string) {
  return useProjectMutation(key, (handle: string) => api.removeHuman(key, handle));
}
export function useSendTeamMessage(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SendTeamMessageRequest) => api.sendTeamMessage(key, body),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.messages(key) }),
  });
}
export function useDeleteMessageAttachment(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMessageAttachment(key, id),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.messages(key) }),
  });
}
export function useReadTeamMessage(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.readTeamMessage(key, id),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.messages(key) }),
  });
}

/** The viewer's conversations with the other members and the unread count the menu shows (PM-78). */
export function useTeamThreads(key: string) {
  return useQuery({ queryKey: queryKeys.teamThreads(key), queryFn: () => api.teamThreads(key) });
}

/**
 * The viewer's own conversation with the project manager (PM-429, PM-1042): who it is, whether it can answer, the
 * latest requests with their steps and, for an owner, the system signals and the queue. Every person of the project
 * reads it.
 */
export function useProjectManagerChannel(key: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projectManager(key),
    queryFn: () => api.projectManager(key),
    enabled,
  });
}

/**
 * The project manager's queue (PM-890, PM-1042): the open items and those closed since `closedSince`. A new
 * `closedSince` keeps the list on screen while it loads, and a refetch keeps the old list when it fails.
 */
export function useOperatorQueue(key: string, handle: string, closedSince: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.operatorQueue(key, handle, closedSince),
    queryFn: () => api.projectManagerQueue(key, closedSince),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** "Most ne": sets one signal aside; the channel is read again for its new state. */
export function useDismissOperatorSignal(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (signalId: string) => api.dismissOperatorSignal(key, signalId),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.projectManager(key) }),
  });
}

/** The team messages written about one card, as the viewer may see them (PM-273). */
export function useTaskMessages(key: string, taskKey: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.taskMessages(key, taskKey),
    queryFn: () => api.teamMessageList(key, { taskKey }),
    enabled,
  });
}

/** One conversation of the viewer with `peer` (every message of the two, up to the page limit). */
export function useConversation(key: string, peer: string | null) {
  return useQuery({
    queryKey: queryKeys.conversation(key, peer ?? ''),
    queryFn: () => api.teamMessageList(key, { threadWith: peer! }),
    enabled: peer !== null,
  });
}

/** The project's messages under the filters; only an owner and an admin get anything beyond their own. */
export function useAllMessages(key: string, filter: AllMessagesFilter, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.allMessages(key, filter),
    queryFn: () =>
      api.teamMessageList(key, {
        member: filter.member || undefined,
        taskKey: filter.task || undefined,
        unreadOnly: filter.unread,
      }),
    enabled,
  });
}

/** Marks the unread messages of an opened conversation read in one request. */
export function useReadTeamMessages(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.readTeamMessages(key, ids),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.messages(key) }),
  });
}

export function useMemberMessages(key: string, handle: string, myHandle: string | null) {
  return useQuery({
    queryKey: queryKeys.messageThread(key, handle),
    queryFn: () => api.teamMessages(key, handle === myHandle ? undefined : handle),
  });
}

export function useUnreadTeamMessages(key: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.unreadMessages(key),
    queryFn: () => api.teamMessages(key, undefined, true),
    enabled,
  });
}

/* ---------- documents (PM-150) ---------- */

export function useDocuments(key: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.documents(key),
    queryFn: () => api.documents(key),
    enabled,
    retry: retryUnlessRefused,
  });
}

/** One document; `version`: an older commit of it. A gone document (404) is final. */
export function useDocument(key: string, slug: string, version?: string) {
  return useQuery({
    queryKey: queryKeys.document(key, slug, version),
    queryFn: () => api.document(key, slug, version),
    enabled: Boolean(slug),
    retry: retryUnlessRefused,
  });
}

export function useDocumentHistory(key: string, slug: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.documentHistory(key, slug),
    queryFn: () => api.documentHistory(key, slug),
    enabled: enabled && Boolean(slug),
    retry: retryUnlessRefused,
  });
}

/** A write changes the list, the document and its history: the live event would do it too, this is the quick path. */
function useDocumentMutation<T, V>(key: string, run: (variables: V) => Promise<T>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.documents(key) }),
  });
}

export function useCreateDocument(key: string) {
  return useDocumentMutation(key, (body: CreateDocumentRequest) => api.createDocument(key, body));
}

export function useUpdateDocument(key: string, slug: string) {
  return useDocumentMutation(key, (body: UpdateDocumentRequest) => api.updateDocument(key, slug, body));
}

export function useRestoreDocument(key: string, slug: string) {
  return useDocumentMutation(key, (body: RestoreDocumentRequest) => api.restoreDocument(key, slug, body));
}

export function useDeleteDocument(key: string, slug: string) {
  return useDocumentMutation(key, (body: DeleteDocumentQuery) => api.deleteDocument(key, slug, body));
}

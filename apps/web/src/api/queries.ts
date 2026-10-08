import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type {
  StopOrphansRequest,
  AttachmentListResponse,
  BoardView,
  InstancePauseView,
  ProjectPauseView,
  BoardMoveRequest,
  SendTeamMessageRequest,
  PatchConfigRequest,
  CreateInviteRequest,
  AcceptInviteRequest,
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
  RetireMemberRequest,
  SessionDetail,
  SetupRequest,
  StartTaskRequest,
  CreateTaskCommentRequest,
  ChangeTaskLabelsRequest,
  LabelView,
} from '@projectman/shared';
import { isApiError } from './client';
import { BoundaryReason } from '@projectman/shared';
import { invalidateAttachments, patchOpenInboxCount, upsertBy, writeTask, writeTaskDetail } from './cache';
import { api } from './endpoints';
import { queryKeys } from './queryKeys';
import type { AllMessagesFilter } from './queryKeys';

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

export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers,
    queryFn: api.providers,
    staleTime: 0,
    refetchInterval: 30_000,
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
      client.setQueryData<SessionDetail>(queryKeys.session(key, session.id), (detail) =>
        detail ? { ...detail, session } : detail,
      ),
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
    mutationFn: ({ item, body }: ResolveVariables) =>
      item.kind === 'boundary'
        ? api.decideBoundary(key, item.id, {
            decision: body.optionId === 'allow' ? 'allow' : 'deny',
            reason: BoundaryReason.parse(body.note),
          })
        : api.resolveInbox(key, item.id, body),
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
      if (next) patchOpenInboxCount(client, key, next);
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
export function useRevokeBoundary(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeBoundary(key, id),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.inbox(key) }),
  });
}

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
export function useUpdateTask(key: string) {
  return useProjectMutation(key, ({ taskKey, body }: { taskKey: string; body: UpdateTaskRequest }) =>
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
  return useProjectMutation(key, ({ taskKey, body }: { taskKey: string; body: CancelTaskRequest }) =>
    api.cancelTask(key, taskKey, body),
  );
}
/** Closes a theme; the cards that belong to it are not touched (PM-192). */
export function useCloseTheme(key: string) {
  return useProjectMutation(key, (taskKey: string) => api.closeTheme(key, taskKey));
}
export function useReopenTask(key: string) {
  return useProjectMutation(key, (taskKey: string) => api.reopenTask(key, taskKey));
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

/** The cards closed in the last `days` days with their rounds and tokens (PM-222). */
export function useClosedCardsMeasure(key: string, days: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.closedCards(key, days),
    queryFn: () => api.closedCardsMeasure(key, days),
    enabled,
  });
}

export function useMemberProfile(key: string, handle: string) {
  return useQuery({
    queryKey: queryKeys.profile(key, handle),
    queryFn: () => api.memberProfile(key, handle),
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

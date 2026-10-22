import type {
  AgentProvider,
  AiMemberConfig,
  EngineId,
  InboxItem,
  MemberHandle,
  ProjectConfig,
  RoleId,
  Session,
  SessionStartCause,
  Task,
  TaskStartWaiting,
  WorkItemRef,
} from '@projectman/shared';
import type { EnsureSessionResult } from '../../contracts';

/** The hub checks whether a current owner has usable explicit super access. No key data crosses this port. */
export interface IntegratorTodoAccess {
  available(config: ProjectConfig): boolean;
}

/** Records all original answers and their durable messages in one unit of work, before delivery. */
export type QuestionGroupAnswerer = (
  items: InboxItem[],
  attachmentIds: readonly string[],
  close: () => void,
) => Promise<void>;

/** The runtime's existing engine and command policy, evaluated with the session engine's paths. */
export interface InboxPermissionPolicy {
  engineIdOf(session: Pick<Session, 'engineId'>): EngineId;
  readableRootsFor(input: {
    config: Pick<ProjectConfig, 'project'>;
    cwd: string;
    projectKey: string;
    task: Pick<Task, 'key' | 'repo'> | null;
    worktreesRootDir?: string;
    attachmentsDir?: string | null;
    parentAttachmentsDir?: string | null;
  }): string[];
  commandVerdict(input: {
    config: ProjectConfig;
    session: { cwd: string; role: RoleId; provider?: AgentProvider; member?: string; branch?: string | null };
    task: Pick<Task, 'repo' | 'merge'> | null;
    toolName: string;
    toolInput: unknown;
    worktreesRootDir?: string;
    workspacesRootDir?: string;
    readableRoots?: readonly string[];
  }): { behavior: 'allow' } | { behavior: 'deny'; message: string } | null;
}

/**
 * Whether the machine a member's sessions run on is reachable (PM-708). `online`: its link is up; `offline`:
 * known but not connected; `unknown`: no machine is chosen. `lastConfirmedOnlineAt` is the last moment the
 * server recorded the machine online (null: never recorded). The state is data of the link, not a member setting.
 */
export interface ScreeningEngineState {
  read(
    projectKey: string,
    member: MemberHandle,
  ): { state: 'online' | 'offline' | 'unknown'; lastConfirmedOnlineAt: string | null };
}

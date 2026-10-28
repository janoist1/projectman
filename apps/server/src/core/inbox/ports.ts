import type { InboxItem, MemberHandle, ProjectConfig } from '@projectman/shared';

/** Whether integrator work stays on its side: an owner has a live super key, so a connected client can work it (PM-1045). */
export interface IntegratorTodoAccess {
  available(config: ProjectConfig): boolean;
}

/** Records all original answers and their durable messages in one unit of work, before delivery. */
export type QuestionGroupAnswerer = (
  items: InboxItem[],
  attachmentIds: readonly string[],
  close: () => void,
) => Promise<void>;

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

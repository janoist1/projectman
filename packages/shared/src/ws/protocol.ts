import { z } from 'zod';
import { MemberView, PlanUsage } from '../api/dto';
import { ChatItem } from '../chat/chat';
import { TimelineEvent } from '../domain/event';
import { InboxItem } from '../domain/inbox';
import { AgentProvider, MemberHandle, MemberStatus } from '../domain/member';
import { TeamMessage } from '../domain/message';
import { ProjectPauseView } from '../domain/pause';
import { Session } from '../domain/session';
import { Task, TaskKey } from '../domain/task';

/** Server -> browser events over the /ws websocket (JSON text frames). */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), serverTime: z.string() }),
  z.object({ type: z.literal('task_upserted'), projectKey: z.string(), task: Task }),
  z.object({ type: z.literal('timeline_appended'), projectKey: z.string(), event: TimelineEvent }),
  z.object({ type: z.literal('session_upserted'), projectKey: z.string(), session: Session }),
  /** The open pauses touching the project changed (PM-219); internal members only. */
  z.object({ type: z.literal('pause_changed'), projectKey: z.string(), pause: ProjectPauseView }),
  z.object({
    type: z.literal('member_state'),
    projectKey: z.string(),
    handle: MemberHandle,
    status: MemberStatus,
    activity: z.string().nullable(),
  }),
  z.object({
    type: z.literal('plan_usage'),
    projectKey: z.string(),
    provider: AgentProvider,
    usage: PlanUsage.nullable(),
  }),
  /** A null member means the handle left the project. */
  z.object({
    type: z.literal('member_changed'),
    projectKey: z.string(),
    handle: MemberHandle,
    member: MemberView.nullable(),
  }),
  z.object({ type: z.literal('inbox_upserted'), projectKey: z.string(), item: InboxItem }),
  z.object({ type: z.literal('team_message'), projectKey: z.string(), message: TeamMessage }),
  z.object({
    type: z.literal('chat_appended'),
    projectKey: z.string(),
    sessionId: z.string(),
    items: z.array(ChatItem),
  }),
  /** Raw PTY output, only sent to clients attached to that terminal. */
  z.object({ type: z.literal('terminal_data'), sessionId: z.string(), data: z.string() }),
  /** Serialized screen + scrollback, sent right after terminal_attach. */
  z.object({
    type: z.literal('terminal_snapshot'),
    sessionId: z.string(),
    data: z.string(),
    cols: z.number().int(),
    rows: z.number().int(),
  }),
  z.object({ type: z.literal('config_changed'), projectKey: z.string(), version: z.string() }),
  /** A task's attachments changed (after the commit); clients read the list again. No more than the key. */
  z.object({ type: z.literal('task_attachments_changed'), projectKey: z.string(), taskKey: TaskKey }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Browser -> server commands. */
export const ClientCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe_project'), projectKey: z.string() }),
  z.object({ type: z.literal('unsubscribe_project'), projectKey: z.string() }),
  z.object({ type: z.literal('terminal_attach'), sessionId: z.string() }),
  z.object({ type: z.literal('terminal_detach'), sessionId: z.string() }),
  z.object({ type: z.literal('terminal_input'), sessionId: z.string(), data: z.string() }),
  z.object({
    type: z.literal('terminal_resize'),
    sessionId: z.string(),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(5).max(300),
  }),
]);
export type ClientCommand = z.infer<typeof ClientCommand>;

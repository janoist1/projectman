import { isAbsolute, resolve, sep } from 'node:path';
import {
  DELEGATION_DELIVERY_TIMEOUT_MS,
  effectiveSessionPermissions,
  memberOf,
  routePermissionRequest,
} from '@projectman/shared';
import type { InboxItem, InboxOption, Session, TimelineEventData } from '@projectman/shared';
import { APPROVER_NONE_REFUSAL } from '../../contracts';
import type {
  EngineDirectory,
  PermissionBroker,
  PermissionDecision,
  PermissionRefusedInfo,
  PermissionRequestInfo,
} from '../../contracts';
import type { DomainContext } from '../../core/base';
import { sponsorOrOwners } from '../../core/inbox';
import type { InboxService } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import type { TimelineService } from '../../core/timeline';
import { SYSTEM_ACTOR, aiActor, excerpt } from '../../kernel';
import { engineIdOf } from './engines';
import { commandVerdict, readableRootsFor } from './session-policy';

const GUEST_CONVERSATION_REFUSAL =
  'This conversation has the team tools only: you read what the person can see and answer them. Nothing else is allowed, and nobody is asked.';

/** Built-in option ids; the web app translates them (labels repeat the id). */
const PERMISSION_OPTIONS: InboxOption[] = [
  { id: 'allow', label: 'allow', style: 'primary' },
  { id: 'allow_session', label: 'allow_session', style: 'secondary' },
  { id: 'deny', label: 'deny', style: 'danger' },
];

/** Evaluates CLI permission requests and waits for inbox decisions on the server. */
export function createPermissionBroker(deps: {
  ctx: DomainContext;
  projects: ProjectService;
  inbox: InboxService;
  timeline: TimelineService;
  engines: EngineDirectory;
  /** The attachment directory of a task: read-only commands there are allowed for its sessions. */
  attachmentDirectory?: (projectKey: string, taskKey: string) => Promise<string>;
}): Pick<PermissionBroker, 'decide' | 'refused'> {
  const { ctx, projects, inbox, timeline, engines, attachmentDirectory } = deps;

  /**
   * The agent's own auto mode refused a tool call (Claude Code's PermissionDenied hook): there is
   * nothing to decide, the timeline shows it (PM-165).
   */
  function classifierRefused(request: PermissionRefusedInfo): void {
    const session = ctx.repos.sessions.get(request.sessionId);
    if (!session) return;
    refused(session, {
      toolName: request.toolName,
      summary: summarizeToolInput(request.toolInput) || request.toolName,
      by: request.by ?? 'classifier',
      ...(request.reason ? { reason: excerpt(request.reason, 500) } : {}),
    });
  }

  function refused(session: Session, data: TimelineEventData['permission_refused']): void {
    timeline.append({
      projectKey: session.projectKey,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      sessionId: session.id,
      actor: SYSTEM_ACTOR,
      type: 'permission_refused',
      data,
    });
  }

  async function decide(request: PermissionRequestInfo, signal: AbortSignal): Promise<PermissionDecision> {
    const session = ctx.repos.sessions.get(request.sessionId);
    if (!session) return { behavior: 'deny', message: 'Unknown session.' };
    // The Operator's conversation with someone who is not an owner has the team tools alone (PM-475):
    // anything else is refused at once, and never becomes an item for the owner to approve.
    if (session.workItem.type === 'general' && session.workItem.with !== undefined) {
      refused(session, {
        toolName: request.toolName,
        summary: summarizeToolInput(request.toolInput, session.cwd) || request.toolName,
        by: 'approver_none',
      });
      return { behavior: 'deny', message: GUEST_CONVERSATION_REFUSAL };
    }
    const config = await projects.config(session.projectKey);
    const summary = summarizeToolInput(request.toolInput, session.cwd);
    const taskKey = session.workItem.type === 'task' ? session.workItem.taskKey : null;
    const member = memberOf(config, session.member);
    const task = taskKey ? ctx.repos.tasks.get(taskKey) : null;
    const attachmentsDir =
      task && task.projectKey === session.projectKey
        ? await attachmentDirectory?.(session.projectKey, task.key).catch(() => null)
        : null;
    const parentAttachmentsDir =
      task?.parentKey && task.projectKey === session.projectKey
        ? await attachmentDirectory?.(session.projectKey, task.parentKey).catch(() => null)
        : null;
    // The places of the engine the session runs on (an engine that is gone has none).
    const engine = engines.get(engineIdOf(session));
    const worktreesRootDir = engine?.paths().worktreesRoot ?? undefined;
    const workspacesRootDir = (engine?.memberWorkspaces ? engine.paths().workspacesRoot : null) ?? undefined;
    const readableRoots = readableRootsFor({
      config,
      cwd: session.cwd,
      projectKey: session.projectKey,
      task,
      worktreesRootDir,
      attachmentsDir,
      parentAttachmentsDir,
    });
    const input = request.toolInput;
    const toolCwd = input && typeof input === 'object' && 'cwd' in input ? input.cwd : undefined;
    let validToolCwd = toolCwd === undefined;
    if (typeof toolCwd === 'string' && isAbsolute(toolCwd) && session.cwd) {
      const under = (p: string, root: string) => p === root || p.startsWith(`${root}${sep}`);
      // The canonical paths are the engine's (the directories are on its disk); a path that is not
      // there, or an engine that is gone, makes the directory invalid.
      try {
        const real = engine
          ? await Promise.all([engine.realpath(toolCwd), engine.realpath(session.cwd)])
          : null;
        validToolCwd =
          under(resolve(toolCwd), resolve(session.cwd)) &&
          real !== null &&
          real[0] !== null &&
          real[1] !== null &&
          under(real[0], real[1]);
      } catch {
        validToolCwd = false;
      }
    }
    const verdict =
      member?.kind === 'ai' && validToolCwd
        ? commandVerdict({
            config,
            session: {
              cwd: typeof toolCwd === 'string' ? toolCwd : session.cwd,
              role: member.role,
              provider: session.provider,
              member: session.member,
              branch: session.branch,
            },
            task,
            toolName: request.toolName,
            toolInput: request.toolInput,
            worktreesRootDir,
            workspacesRootDir,
            readableRoots,
          })
        : null;
    // Nobody approves this member's questions (PM-165): refused at once, without an inbox item. The
    // command rules above still come first (a routine step is allowed, publishing is denied); only a
    // request they leave open is refused here. The approver is the one that applies to the session:
    // its own, set by an owner, from the next question on (PM-170), else the member's.
    const approver = member?.kind === 'ai' ? effectiveSessionPermissions(member, session).approver : null;
    if (!verdict && approver === 'none') {
      refused(session, { toolName: request.toolName, summary, by: 'approver_none' });
      return { behavior: 'deny', message: APPROVER_NONE_REFUSAL };
    }
    // The approver `ai` (PM-169): the member's AI decider answers, unless the request is one of the
    // owner's categories or there is no decider at work, and then a person does, as for `human`.
    // The session's own directories, not the read-only attachments, are where it may write.
    const route =
      !verdict && member?.kind === 'ai' && approver
        ? routePermissionRequest(config, session.member, {
            toolName: request.toolName,
            toolInput: request.toolInput,
            roots: readableRoots.filter((root) => root !== attachmentsDir && root !== parentAttachmentsDir),
            approver,
          })
        : null;
    const delegation =
      route?.to === 'ai'
        ? {
            state: 'pending_lead' as const,
            leads: route.leads,
            // The decider's own time counts from the first delivery (`recordDelegationDelivered`).
            leadDeadline: new Date(ctx.now().getTime() + DELEGATION_DELIVERY_TIMEOUT_MS).toISOString(),
          }
        : null;
    const item = inbox.create({
      projectKey: session.projectKey,
      kind: 'permission',
      assignees: delegation ? delegation.leads : sponsorOrOwners(config, session.member),
      source: session.member,
      sessionId: session.id,
      taskKey,
      title: summary ? `${request.toolName}: ${summary}` : request.toolName,
      payload: {
        toolName: request.toolName,
        toolInput: request.toolInput ?? null,
        summary,
        ...(delegation ? { delegation } : {}),
        ...(route?.to === 'human' && route.category ? { ownerCategory: route.category } : {}),
      },
      options: PERMISSION_OPTIONS,
    });
    timeline.append({
      projectKey: session.projectKey,
      taskKey,
      sessionId: session.id,
      actor: aiActor(session.member),
      type: 'permission_requested',
      data: { inboxItemId: item.id, toolName: request.toolName, summary },
    });

    if (verdict) {
      inbox.resolveByRule(item.id, verdict.behavior, 'command_policy');
      timeline.append({
        projectKey: session.projectKey,
        taskKey,
        sessionId: session.id,
        actor: SYSTEM_ACTOR,
        type: 'permission_resolved',
        data: { inboxItemId: item.id, decision: verdict.behavior, optionId: verdict.behavior },
      });
      return verdict;
    }

    // The AI decider's queue item came with the inbox item (the member queue); the hook below waits for its
    // answer like for a person's.
    const closed = await inbox.waitForClose(item.id, signal);
    return closed
      ? toPermissionDecision(closed)
      : { behavior: 'deny', message: 'No human decided in time; the request expired.' };
  }

  return { decide, refused: classifierRefused };
}

/** One-line summary of a tool call for humans, e.g. the Bash command or the edited file. */
function summarizeToolInput(input: unknown, sessionCwd?: string | null): string {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  for (const key of [
    'command',
    'file_path',
    'notebook_path',
    'path',
    'url',
    'pattern',
    'description',
    'prompt',
  ]) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      const prefix =
        key === 'command' && typeof obj.cwd === 'string' && isAbsolute(obj.cwd) && obj.cwd !== sessionCwd
          ? `${obj.cwd}$ `
          : '';
      return excerpt(`${prefix}${value}`, 200);
    }
  }
  try {
    return excerpt(JSON.stringify(input) ?? '', 200);
  } catch {
    return '';
  }
}

function toPermissionDecision(item: InboxItem): PermissionDecision {
  const resolution = item.resolution;
  if (item.state === 'resolved' && resolution) {
    if (resolution.optionId === 'allow') return { behavior: 'allow' };
    if (resolution.optionId === 'allow_session') return { behavior: 'allow', rememberForSession: true };
    const reason = resolution.note ? `: ${resolution.note}` : '.';
    return { behavior: 'deny', message: `Denied by ${resolution.by}${reason}` };
  }
  return { behavior: 'deny', message: `The permission request was ${item.state}.` };
}

import { AttachmentId, DEFAULT_AGENT_PROVIDER, MessageAttachmentId } from '@projectman/shared';
import type { Attachment } from '@projectman/shared';
import { PROVIDER_MCP_IMAGE_RESULTS, TeamToolError } from '../../contracts';
import type {
  AttachmentOperations,
  AttachmentPage,
  EngineAttachments,
  EngineHost,
  EngineSessionFolders,
  LocatedAttachmentForTool,
  MessageAttachmentReading,
  ToolContext,
} from '../../contracts';
import type { DomainContext } from '../../domain/context';
import { DomainError } from '../../domain/errors';
import { sessionFileName } from '../../domain/message-attachments';
import type { MessageAttachmentService } from '../../domain/message-attachments';
import type { TaskService } from '../../domain/tasks';
import { attachmentToolRules } from '../../domain/session-policy';
import { aiActor, humanActor } from '../../domain/util';

import { type ToolCaller, toFileToolError } from '../caller';
import type { AttachmentToolsHandler } from '../../contracts';
const MAX_ATTACHMENT_PAGE = 200;
/** An attachment that is not (or no longer) there, in words that say where to look. */
function toAttachmentToolError(err: unknown, taskKey: string, id: string): unknown {
  if (
    err instanceof DomainError &&
    err.code === 'not_found' &&
    (err.details as { what?: string })?.what === 'attachment'
  )
    return new TeamToolError(
      'not_found',
      `${taskKey} has no attachment ${id} (or it is being deleted); list them with list_attachments.`,
    );
  return err;
}
export class AttachmentTools implements AttachmentToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: DomainContext;
  private readonly tasks: Pick<TaskService, 'find'>;
  private readonly attachments: AttachmentOperations;
  private readonly messageAttachments: Pick<MessageAttachmentService, 'reading' | 'source'>;
  private readonly attachmentDirectory: (projectKey: string, taskKey: string) => Promise<string>;
  private readonly materializeAttachment: EngineAttachments['materialize'] | undefined;
  private readonly sessionEngine:
    | ((
        sessionId: string,
      ) => Pick<EngineHost, 'sessionFolders' | 'isRealDirectory' | 'openWorkspaceFile'> | undefined)
    | undefined;
  constructor(deps: {
    calls: ToolCaller;
    ctx: DomainContext;
    tasks: Pick<TaskService, 'find'>;
    attachments: AttachmentOperations;
    messageAttachments: Pick<MessageAttachmentService, 'reading' | 'source'>;
    attachmentDirectory: (projectKey: string, taskKey: string) => Promise<string>;
    materializeAttachment?: EngineAttachments['materialize'] | undefined;
    sessionEngine?:
      | ((
          sessionId: string,
        ) => Pick<EngineHost, 'sessionFolders' | 'isRealDirectory' | 'openWorkspaceFile'> | undefined)
      | undefined;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.tasks = deps.tasks;
    this.attachments = deps.attachments;
    this.messageAttachments = deps.messageAttachments;
    this.attachmentDirectory = deps.attachmentDirectory;
    this.materializeAttachment = deps.materializeAttachment;
    this.sessionEngine = deps.sessionEngine;
  }
  async listAttachments(
    ctx: ToolContext,
    args: { taskKey: string; offset?: number; limit?: number },
  ): Promise<AttachmentPage> {
    return this.calls.guard(async () => {
      const { guest } = await this.calls.callerWithRequest(ctx, 'list_attachments');
      const taskKey = this.calls.visibleTaskKey(ctx, guest, args.taskKey);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      if (!Number.isInteger(offset) || offset < 0)
        throw new TeamToolError('invalid', 'offset must be a whole number, 0 or more.');
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ATTACHMENT_PAGE)
        throw new TeamToolError('invalid', `limit must be an integer between 1 and ${MAX_ATTACHMENT_PAGE}.`);
      const all = await this.attachments.list(
        ctx.projectKey,
        taskKey,
        guest ? humanActor(guest.handle) : aiActor(ctx.member),
      );
      return { attachments: all.slice(offset, offset + limit), total: all.length, offset };
    });
  }

  async readAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<LocatedAttachmentForTool> {
    return this.calls.guard(async () => {
      const { guest } = await this.calls.callerWithRequest(ctx, 'read_attachment');
      const taskKey = this.calls.visibleTaskKey(ctx, guest, args.taskKey);
      const id = this.validAttachmentId(args.attachmentId);
      const located = await this.attachments
        .locate(ctx.projectKey, taskKey, id, guest ? humanActor(guest.handle) : aiActor(ctx.member))
        .catch((err: unknown) => {
          throw toAttachmentToolError(err, taskKey, id);
        });
      // The session reads without asking only its own task's attachment directory and its direct
      // parent's (PM-228; see `attachmentToolRules`).
      const sessionTask = ctx.taskKey ? this.tasks.find(ctx.projectKey, ctx.taskKey) : null;
      const own =
        (ctx.taskKey === taskKey || (sessionTask?.parentKey ?? null) === taskKey) &&
        attachmentToolRules(await this.attachmentDirectory(ctx.projectKey, taskKey).catch(() => null)).allow
          .length > 0;
      // A session on another machine reads the file there: the engine gets it first (PM-315).
      const path = this.materializeAttachment
        ? await this.materializeAttachment({
            sessionId: ctx.sessionId,
            projectKey: ctx.projectKey,
            taskKey,
            attachment: located.attachment,
            storedPath: located.path,
          }).catch((err: unknown) => {
            if (err instanceof DomainError && err.code === 'engine_offline')
              throw new TeamToolError('invalid', 'The engine your session runs on is not connected.');
            throw err;
          })
        : located.path;
      return { ...located, path, readableWithoutAsking: own };
    });
  }

  async readMessageAttachment(
    ctx: ToolContext,
    args: { attachmentId: string },
  ): Promise<MessageAttachmentReading> {
    return this.calls.guard(async () => {
      const { guest } = await this.calls.callerWithRequest(ctx, 'read_message_attachment');
      const id = args.attachmentId;
      if (!MessageAttachmentId.safeParse(id).success)
        throw new TeamToolError(
          'invalid',
          `Invalid message attachment id "${id}"; they look like "msa_…" (in the Attachments block of a message).`,
        );
      // The file is judged through the eyes of whoever the session talks for: the AI member, or the
      // guest of an Operator conversation, so a file of a message they cannot see is not found.
      const viewer = guest ? guest.viewer : { access: 'ai' as const, handle: ctx.member };
      // A session with file tools of its own gets what the content cannot show as a file in its
      // session folder (PM-518). A guest conversation reads no file at all: it has no folder.
      const target = guest ? null : this.sessionFileTarget(ctx);
      const notFound = (err: unknown): never => {
        if (err instanceof DomainError && err.code === 'not_found')
          throw new TeamToolError(
            'not_found',
            `There is no message attachment ${id} that you can see (or it was deleted).`,
          );
        throw err;
      };
      const reading = await this.messageAttachments
        .reading(ctx.projectKey, id, viewer, { images: !target || target.mcpImageResults })
        .catch(notFound);
      if (!target || reading.content.kind !== 'none') return reading;
      try {
        const source = await this.messageAttachments.source(ctx.projectKey, id, viewer);
        const file = await target.folders.materializeFile(target.sessionId, {
          name: sessionFileName(id, reading.attachment.fileName),
          source,
        });
        return { ...reading, file: { path: file.path } };
      } catch (err) {
        // The file is an addition: an engine that cannot take it (offline, older, no folder for
        // the session) leaves the reading as it is, with the entry only.
        this.ctx.logger.warn(
          { err, attachment: id, session: target.sessionId },
          'message attachment could not be put into the session folder',
        );
        return reading;
      }
    });
  }

  async attachFile(
    ctx: ToolContext,
    args: { taskKey: string; path: string },
  ): Promise<{ attachment: Attachment }> {
    return this.calls.guard(async () => {
      const who = await this.calls.callerWithRequest(ctx, 'attach_file');
      return this.calls.recorded(who, { action: 'task_update', taskKey: args.taskKey }, () =>
        this.attachFileOf(ctx, args),
      );
    });
  }

  async deleteAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<{ attachmentId: string; fileName: string | null }> {
    return this.calls.guard(async () => {
      const who = await this.calls.callerWithRequest(ctx, 'delete_attachment');
      return this.calls.recorded(who, { action: 'task_update', taskKey: args.taskKey }, async () => {
        const taskKey = this.calls.validTaskKey(ctx, args.taskKey);
        const id = this.validAttachmentId(args.attachmentId);
        const actor = aiActor(ctx.member);
        const fileName =
          (await this.attachments.list(ctx.projectKey, taskKey, actor)).find((a) => a.id === id)?.fileName ??
          null;
        // The same rule as the REST route: the uploader, or a human owner or admin.
        await this.attachments.delete(ctx.projectKey, taskKey, id, actor).catch((err: unknown) => {
          if (err instanceof DomainError && err.status === 403)
            throw new TeamToolError(
              'forbidden',
              `You can delete only the attachments you attached yourself; ${id} is someone else's. Ask an ` +
                'owner or admin if it has to go.',
            );
          throw toAttachmentToolError(err, taskKey, id);
        });
        return { attachmentId: id, fileName };
      });
    });
  }

  /**
   * Where the calling session's files go (PM-518): its engine's session folders when the session has
   * a folder of its own there, and whether its CLI shows an image in a tool result. Null: the session
   * has no folder (a provider without session folders, an unknown session), so it
   * gets the content only.
   */
  private sessionFileTarget(
    ctx: ToolContext,
  ): { sessionId: string; folders: EngineSessionFolders; mcpImageResults: boolean } | null {
    const session = this.ctx.repos.sessions.get(ctx.sessionId);
    if (!session || session.projectKey !== ctx.projectKey || session.member !== ctx.member) return null;
    const folders = this.sessionEngine?.(session.id)?.sessionFolders;
    if (!folders?.of(session.id)) return null;
    return {
      sessionId: session.id,
      folders,
      mcpImageResults: PROVIDER_MCP_IMAGE_RESULTS[session.provider ?? DEFAULT_AGENT_PROVIDER],
    };
  }

  private async attachFileOf(
    ctx: ToolContext,
    args: { taskKey: string; path: string },
  ): Promise<{ attachment: Attachment }> {
    const taskKey = this.calls.validTaskKey(ctx, args.taskKey);
    const actor = aiActor(ctx.member);
    await this.attachments.assertCanUpload(ctx.projectKey, taskKey, actor);
    const file = await this.calls.openSessionFile(ctx, args.path, 'attached');
    try {
      const attachment = await this.attachments.upload({
        projectKey: ctx.projectKey,
        taskKey,
        actor,
        fileName: file.name,
        content: file.stream(),
        beforeCommit: () => file.verifyUnchanged(),
      });
      return { attachment };
    } catch (err) {
      throw toFileToolError(err, args.path);
    } finally {
      await file.close();
    }
  }

  private validAttachmentId(id: string): string {
    if (!AttachmentId.safeParse(id).success)
      throw new TeamToolError(
        'invalid',
        `Invalid attachment id "${id}"; attachment ids look like "att_…" (see get_task or list_attachments).`,
      );
    return id;
  }
}

import type { ToolContext } from '../../contracts';
import { TeamToolError } from '../../contracts';
import { type ToolCaller, toToolError, isOwner } from '../caller';
import {
  canReadAttachments,
  coordinationMemberOf,
  ownerHandles,
  isOperator,
  memberOf,
  QUESTION_SCREENING_MINUTES,
  questionChoices,
  questionApprovalLabel,
  questionPayloadOf,
} from '@projectman/shared';
import type {
  InboxOption,
  ProjectConfig,
  QuestionAttachment,
  QuestionOptionInput,
  Task,
} from '@projectman/shared';
import type { InboxToolsHandler } from '../../contracts';
import type { DomainContext } from '../../core/base';
import { DomainError } from '../../kernel';
import { ANSWER_OPTION, sponsorOrOwners } from '../../core/inbox';
import type { InboxService } from '../../core/inbox';
import type { TaskService } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import type { QuestionScreening } from '../../core/inbox';
import type { OpenQuestionLabel } from '../../core/inbox';
import { aiActor, unique } from '../../kernel';

export class InboxTools implements InboxToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: DomainContext;
  private readonly tasks: TaskService;
  private readonly inbox: InboxService;
  private readonly timeline: TimelineService;
  private readonly questionScreening: Pick<QuestionScreening, 'enqueue' | 'enabled' | 'cannotScreen'>;
  private readonly openQuestionLabel: OpenQuestionLabel;
  constructor(deps: {
    calls: ToolCaller;
    ctx: DomainContext;
    tasks: TaskService;
    inbox: InboxService;
    timeline: TimelineService;
    questionScreening: Pick<QuestionScreening, 'enqueue' | 'enabled' | 'cannotScreen'>;
    openQuestionLabel: OpenQuestionLabel;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.tasks = deps.tasks;
    this.inbox = deps.inbox;
    this.timeline = deps.timeline;
    this.questionScreening = deps.questionScreening;
    this.openQuestionLabel = deps.openQuestionLabel;
  }

  async decidePermissionRequest(
    ctx: ToolContext,
    args: { requestId: string; decision: 'allow' | 'deny' | 'escalate'; reason: string },
  ) {
    try {
      await this.calls.caller(ctx, 'decide_permission_request');
      const item = await this.inbox.resolveDelegated(ctx.projectKey, args.requestId, ctx.member, {
        decision: args.decision,
        reason: args.reason,
      });
      return {
        requestId: item.id,
        decision: args.decision,
        outcome: args.decision === 'escalate' ? 'handed to a person' : 'decided; the request is answered',
      };
    } catch (err) {
      if (err instanceof DomainError && err.code === 'inbox_item_closed') {
        const state = (err.details as { state?: string }).state;
        throw new TeamToolError(
          'invalid',
          state === 'expired'
            ? 'inbox_item_closed: expired — nothing reached the session'
            : 'inbox_item_closed: already decided',
        );
      }
      throw toToolError(err);
    }
  }

  async askHuman(
    ctx: ToolContext,
    args: {
      question: string;
      options?: QuestionOptionInput[];
      taskKey?: string;
      to?: string[];
      recommended?: string;
      recommendationReason?: string;
      details?: string;
      attachmentIds?: string[];
      /** The question asked again after the Operator screened it away (PM-558), and why a person must see it. */
      reaskOf?: string;
      reaskReason?: string;
    },
  ): Promise<{
    inboxItemId: string;
    approvalLabel?: string;
    attachments?: QuestionAttachment[];
    screening?: true;
  }> {
    return this.calls.guard(async () => {
      const config = await this.calls.caller(ctx, 'ask_human');
      const question = args.question.trim();
      if (!question) throw new TeamToolError('invalid', 'The question is empty.');
      const taskKey = this.calls.taskKeyFor(ctx, args.taskKey);
      // The Operator asks only the owners (PM-463): an answer of anyone else would not be a request to it.
      const operator = isOperator(memberOf(config, ctx.member));
      const unscreened = this.reask(ctx, args.reaskOf, args.reaskReason);
      // Every other AI member's question goes through the Operator first (PM-558); a re-ask does not.
      const screened =
        this.questionScreening.enabled &&
        coordinationMemberOf(config)?.handle !== ctx.member &&
        !unscreened &&
        memberOf(config, ctx.member)?.kind === 'ai';
      let assignees: string[];
      if (args.to && args.to.length > 0) {
        const notHuman = args.to.filter((h) => memberOf(config, h)?.kind !== 'human');
        if (notHuman.length > 0)
          throw new TeamToolError(
            'invalid',
            `ask_human can only ask human members; these are not: ${notHuman.join(', ')}.`,
          );
        const notOwner = operator ? args.to.filter((h) => !isOwner(config, h)) : [];
        if (notOwner.length > 0)
          throw new TeamToolError(
            'invalid',
            `operator_owner_only: the Operator asks only the owners; these are not: ${notOwner.join(', ')}.`,
          );
        assignees = unique(args.to);
      } else {
        assignees = operator ? ownerHandles(config) : sponsorOrOwners(config, ctx.member);
      }
      const choices = questionChoices(args.options);
      const recommended = args.recommended?.trim();
      const reason = args.recommendationReason?.trim();
      const details = args.details?.trim();
      // The team tool checks this at its boundary; a direct caller gets the same answer.
      const recommendedIndex = recommended ? choices.findIndex((choice) => choice.label === recommended) : -1;
      if (recommended && recommendedIndex < 0) {
        throw new TeamToolError(
          'invalid',
          `The recommended option "${recommended}" is not one of the options.`,
        );
      }
      if (reason && !recommended) {
        throw new TeamToolError('invalid', 'A recommendation reason needs a recommended option.');
      }
      // The recommended option is the primary button; without a recommendation the first one is.
      const primary = Math.max(recommendedIndex, 0);
      const options: InboxOption[] = [
        ...choices.map((choice, i): InboxOption => ({
          id: `option_${i + 1}`,
          label: choice.label,
          style: i === primary ? 'primary' : 'secondary',
          ...(choice.consequence ? { consequence: choice.consequence } : {}),
        })),
        ANSWER_OPTION,
      ];
      // A question about a card holds it back while it is open: the label goes on first, so the
      // question records that the system put it there.
      const task = taskKey ? this.tasks.find(ctx.projectKey, taskKey) : null;
      const approvalLabel = task
        ? questionApprovalLabel(config, task, {
            text: [question, ...choices.flatMap((choice) => [choice.label, choice.consequence]), details]
              .filter(Boolean)
              .join('\n'),
            assignees,
          })
        : null;
      // The files are checked before the label is claimed: a refusal leaves no waiting label behind.
      const attachments = this.questionAttachments(
        config,
        ctx.projectKey,
        task,
        assignees,
        args.attachmentIds,
      );
      const autoLabel = await this.openQuestionLabel.claim(ctx.projectKey, taskKey, ctx.member, question);
      const item = this.inbox.create({
        projectKey: ctx.projectKey,
        kind: 'question',
        assignees,
        source: ctx.member,
        sessionId: ctx.sessionId,
        taskKey,
        title: question,
        ...(screened ? { state: 'screening' as const } : {}),
        payload: {
          question,
          ...(screened
            ? {
                screening: {
                  until: new Date(
                    this.ctx.now().getTime() + QUESTION_SCREENING_MINUTES * 60_000,
                  ).toISOString(),
                },
              }
            : {}),
          ...(unscreened ? { unscreened } : {}),
          options: choices.map((choice) => choice.label),
          ...(approvalLabel ? { approvalLabel } : {}),
          ...(recommendedIndex >= 0 ? { recommended: options[recommendedIndex]!.id } : {}),
          ...(reason ? { recommendationReason: reason } : {}),
          ...(details ? { details } : {}),
          ...(autoLabel ? { autoLabel } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        options,
      });
      this.timeline.append({
        projectKey: ctx.projectKey,
        taskKey,
        sessionId: ctx.sessionId,
        actor: aiActor(ctx.member),
        type: 'question_asked',
        data: {
          inboxItemId: item.id,
          question,
          ...(screened ? { screening: true as const } : {}),
          ...(unscreened ? { unscreened } : {}),
        },
      });
      // An Operator that cannot take it gives the question to the people before this call returns; one that
      // can is woken without waiting for its session.
      const hopeless = screened && this.questionScreening.cannotScreen(ctx.projectKey, config);
      if (screened) {
        const handed = this.questionScreening.enqueue(ctx.projectKey).catch((err: unknown) => {
          this.ctx.logger.warn({ err, inboxItemId: item.id }, 'could not hand a question to the screening');
        });
        if (hopeless) await handed;
        else void handed;
      }
      return {
        inboxItemId: item.id,
        ...(approvalLabel ? { approvalLabel } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(screened && !hopeless ? { screening: true as const } : {}),
      };
    });
  }

  async withdrawQuestion(
    ctx: ToolContext,
    args: { itemId: string; reason: string },
  ): Promise<{ itemId: string }> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'withdraw_question');
      const reason = args.reason.trim();
      if (!reason) throw new TeamToolError('invalid', 'The reason is empty.');
      const item = this.ctx.repos.inbox.get(args.itemId);
      if (!item || item.projectKey !== ctx.projectKey || item.kind !== 'question')
        throw new TeamToolError('not_found', `Question ${args.itemId} does not exist in this project.`);
      if (item.source !== ctx.member)
        throw new TeamToolError(
          'forbidden',
          `not_your_question: question ${item.id} was asked by ${item.source}; only the asker withdraws it.`,
        );
      const closed = await this.inbox.closeQuestion(item.id, {
        rule: 'withdrawn',
        by: ctx.member,
        note: reason,
      });
      if (!closed)
        throw new TeamToolError('invalid', `question_closed: question ${item.id} is not waiting any more.`);
      return { itemId: closed.id };
    });
  }

  /**
   * A question asked again after the Operator answered, forwarded or closed it (PM-558): the new question
   * goes to the people unscreened, once per earlier question. Returns what the new item records, or null for
   * an ordinary question. Throws `reask_not_allowed` before anything is written.
   */
  private reask(
    ctx: ToolContext,
    reaskOf: string | undefined,
    reaskReason: string | undefined,
  ): { reason: string; previousItemId: string } | null {
    const reason = reaskReason?.trim();
    if (reaskOf === undefined && reason === undefined) return null;
    if (!reaskOf || !reason)
      throw new TeamToolError('invalid', 'reask_not_allowed: reask_of and reask_reason go together.');
    const previous = this.ctx.repos.inbox.get(reaskOf);
    if (!previous || previous.projectKey !== ctx.projectKey || previous.kind !== 'question')
      throw new TeamToolError('invalid', 'reask_not_allowed: there is no such question of yours.');
    if (previous.source !== ctx.member)
      throw new TeamToolError('invalid', 'reask_not_allowed: only the member who asked may ask again.');
    const outcome = questionPayloadOf(previous)?.screening?.outcome;
    if (outcome !== 'answered' && outcome !== 'forwarded' && outcome !== 'moot')
      throw new TeamToolError(
        'invalid',
        'reask_not_allowed: the Operator did not answer, forward or close that question.',
      );
    const asked = this.inbox
      .list(ctx.projectKey, { kind: 'question', limit: 100_000 })
      .some((item) => questionPayloadOf(item)?.unscreened?.previousItemId === reaskOf);
    if (asked)
      throw new TeamToolError('invalid', 'reask_not_allowed: that question was already asked again.');
    return { reason, previousItemId: reaskOf };
  }

  /**
   * The files a question names (PM-498), as snapshots in the order given and without repeats. Only
   * ready files of the question's card or its parent qualify, and every asked person must be able
   * to open each of them. Throws before anything is written.
   */
  private questionAttachments(
    config: ProjectConfig,
    projectKey: string,
    task: Task | null,
    assignees: string[],
    ids: string[] | undefined,
  ): QuestionAttachment[] {
    const wanted = unique(ids ?? []);
    if (wanted.length === 0) return [];
    if (!task)
      throw new TeamToolError(
        'invalid',
        'attachments_need_card: files can be named only on a question about a card; give task_key or ask without attachments.',
      );
    const parent = task.parentKey ? this.tasks.find(projectKey, task.parentKey) : null;
    const allowed = [task, ...(parent ? [parent] : [])];
    const scope = parent ? `${task.key} or its parent ${parent.key}` : task.key;
    const found: QuestionAttachment[] = [];
    for (const id of wanted) {
      const row = this.ctx.repos.attachments.get(id);
      if (!row || row.projectKey !== projectKey || row.state !== 'ready')
        throw new TeamToolError(
          'not_found',
          `attachment_unknown: ${id} is not a file of ${scope}; list_attachments gives the ids.`,
        );
      if (!allowed.some((card) => card.key === row.taskKey))
        throw new TeamToolError(
          'invalid',
          `attachment_other_card: ${id} is on ${row.taskKey}; a question can name only the files of ${scope}.`,
        );
      found.push({
        id: row.id,
        taskKey: row.taskKey,
        fileName: row.fileName,
        size: row.size,
        mediaType: row.mediaType,
        preview: row.preview,
      });
    }
    // Everyone asked must be able to open every file; only a client asked about an internal card can fail.
    for (const handle of assignees) {
      const person = memberOf(config, handle);
      const viewer = { access: person?.kind === 'human' ? person.access : ('client' as const), handle };
      for (const card of allowed) {
        if (!found.some((file) => file.taskKey === card.key)) continue;
        if (!canReadAttachments(viewer, card))
          throw new TeamToolError(
            'invalid',
            `attachment_not_visible: ${handle} cannot open the files of ${card.key}; ask without them or ask someone who sees the card.`,
          );
      }
    }
    return found;
  }
}

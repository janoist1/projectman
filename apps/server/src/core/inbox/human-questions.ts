import {
  coordinationMemberOf,
  externalOriginActor,
  hasBoundOrigin,
  memberOf,
  ownerHandles,
  QUESTION_SCREENING_MINUTES,
  questionApprovalLabel,
  questionChoices,
  questionPayloadOf,
} from '@projectman/shared';
import type {
  ExternalQuestionRead,
  ExternalToolOrigin,
  InboxItem,
  InboxOption,
  ProjectConfig,
  QuestionAttachment,
  Task,
} from '@projectman/shared';
import type {
  AskedHuman,
  HumanQuestionCaller,
  HumanQuestionInput,
  HumanQuestionsPort,
} from '../../contracts';
import { aiActor, conflict, DomainError, unique } from '../../kernel';
import type { DomainContext } from '../base';
import type { ProjectService } from '../projects';
import type { TaskService } from '../tasks';
import type { TimelineService } from '../timeline';
import { answerText, ANSWER_OPTION, sponsorOrOwners } from './inbox';
import type { InboxService } from './inbox';
import type { OpenQuestionLabel } from './open-question-label';
import type { QuestionScreening } from './question-screening';

const refuse = (message: string) => new DomainError('invalid_request', message);
const missing = (message: string) => new DomainError('not_found', message, { status: 404 });

/**
 * The questions people are asked (PM-784), for a member in a session and for the integrator in super mode.
 * The member path is the one the `ask_human` tool always had: the Operator's screening, the sponsor as
 * the default asked person, the re-ask. The integrator path has no session and no screening: the question
 * goes straight to the owners (or the humans named), it is answered only by a person's own login, and the
 * answer waits in the inbox and in one durable message until the integrator reads it.
 */
export class HumanQuestions implements HumanQuestionsPort {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly inbox: InboxService;
  private readonly timeline: TimelineService;
  private readonly questionScreening: Pick<QuestionScreening, 'enqueue' | 'enabled' | 'cannotScreen'>;
  private readonly openQuestionLabel: OpenQuestionLabel;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    inbox: InboxService;
    timeline: TimelineService;
    questionScreening: Pick<QuestionScreening, 'enqueue' | 'enabled' | 'cannotScreen'>;
    openQuestionLabel: OpenQuestionLabel;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.inbox = deps.inbox;
    this.timeline = deps.timeline;
    this.questionScreening = deps.questionScreening;
    this.openQuestionLabel = deps.openQuestionLabel;
  }

  async ask(projectKey: string, caller: HumanQuestionCaller, input: HumanQuestionInput): Promise<AskedHuman> {
    const config = await this.projects.config(projectKey);
    const external = caller.kind === 'external';
    const asker = external ? caller.origin.actor.handle : caller.member;
    if (external && !hasBoundOrigin(caller.origin.actor))
      throw new DomainError('integrator_not_allowed', 'Only a connected Claude asks the owners here', {
        status: 403,
      });
    const question = input.question.trim();
    if (!question) throw refuse('The question is empty.');
    const taskKey = input.taskKey ?? null;
    const task = taskKey ? this.tasks.find(projectKey, taskKey) : null;
    if (taskKey && !task) throw missing(`Task ${taskKey} does not exist in this project.`);

    // A connected Claude asks only the owners (decision 66): an answer of anyone else would not be a
    // request to them.
    let unscreened: { reason: string; previousItemId: string } | null = null;
    if (caller.kind === 'member') unscreened = this.reask(projectKey, caller.member, input);
    else if (
      input.reaskOf !== undefined ||
      input.reaskReason !== undefined ||
      (input.recipient !== undefined && input.recipient !== 'owner')
    )
      throw refuse('The integrator cannot re-ask or choose the recipient.');
    // Every other AI member's question goes through the Operator first (PM-558); a re-ask does not.
    const screened =
      caller.kind === 'member' &&
      this.questionScreening.enabled &&
      coordinationMemberOf(config)?.handle !== asker &&
      !unscreened &&
      memberOf(config, asker)?.kind === 'ai';

    const responsePurpose = input.responsePurpose ?? (external ? 'owner_decision' : undefined);
    let assignees: string[];
    if (input.to && input.to.length > 0) {
      const notHuman = input.to.filter((h) => memberOf(config, h)?.kind !== 'human');
      if (notHuman.length > 0)
        throw refuse(`ask_human can only ask human members; these are not: ${notHuman.join(', ')}.`);
      const owners = ownerHandles(config);
      const notOwner = external ? input.to.filter((h) => !owners.includes(h)) : [];
      if (notOwner.length > 0)
        throw refuse(
          `operator_owner_only: the integrator asks only the owners; these are not: ${notOwner.join(', ')}.`,
        );
      assignees = unique(input.to);
    } else {
      assignees = external ? ownerHandles(config) : sponsorOrOwners(config, asker);
    }

    const choices = questionChoices(input.options);
    const recommended = input.recommended?.trim();
    const reason = input.recommendationReason?.trim();
    const details = input.details?.trim();
    // The team tool checks this at its boundary; a direct caller gets the same answer.
    const recommendedIndex = recommended ? choices.findIndex((choice) => choice.label === recommended) : -1;
    if (recommended && recommendedIndex < 0)
      throw refuse(`The recommended option "${recommended}" is not one of the options.`);
    if (reason && !recommended) throw refuse('A recommendation reason needs a recommended option.');
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
    const approvalLabel = task
      ? questionApprovalLabel(config, task, {
          text: [question, ...choices.flatMap((choice) => [choice.label, choice.consequence]), details]
            .filter(Boolean)
            .join('\n'),
          assignees,
        })
      : null;
    // The files are checked before the label is claimed: a refusal leaves no waiting label behind.
    const attachments = this.questionAttachments(config, projectKey, task, assignees, input.attachmentIds);
    const autoLabel = await this.openQuestionLabel.claim(projectKey, taskKey, asker, question);
    const requestedRecipient = input.recipient ?? 'owner';
    const item = this.inbox.create({
      projectKey,
      kind: 'question',
      assignees,
      source: asker,
      sessionId: caller.kind === 'member' ? caller.sessionId : null,
      taskKey,
      title: question,
      ...(screened ? { state: 'screening' as const } : {}),
      payload: {
        question,
        requestedRecipient,
        recipient: 'owner',
        ...(screened
          ? {
              screening: {
                until: new Date(this.ctx.now().getTime() + QUESTION_SCREENING_MINUTES * 60_000).toISOString(),
              },
            }
          : {}),
        ...(unscreened ? { unscreened } : {}),
        // A question that appears to ask for an approval is always an owner decision (PM-762): the asking
        // member cannot make it relayable.
        ...(approvalLabel
          ? { responsePurpose: 'owner_decision' as const }
          : responsePurpose
            ? { responsePurpose }
            : {}),
        options: choices.map((choice) => choice.label),
        ...(approvalLabel ? { approvalLabel } : {}),
        ...(recommendedIndex >= 0 ? { recommended: options[recommendedIndex]!.id } : {}),
        ...(reason ? { recommendationReason: reason } : {}),
        ...(details ? { details } : {}),
        ...(autoLabel ? { autoLabel } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(input.signalId ? { signalId: input.signalId } : {}),
        ...(caller.kind === 'external' ? { externalQuestion: caller.origin } : {}),
      },
      options,
    });
    this.timeline.append({
      projectKey,
      taskKey,
      sessionId: caller.kind === 'member' ? caller.sessionId : null,
      actor: caller.kind === 'external' ? externalOriginActor(caller.origin) : aiActor(asker),
      type: 'question_asked',
      data: {
        inboxItemId: item.id,
        question,
        requestedRecipient,
        ...(screened ? { screening: true as const } : {}),
        ...(unscreened ? { unscreened } : {}),
      },
    });
    // An Operator that cannot take it gives the question to the people before this call returns; one that
    // can is woken without waiting for its session.
    const hopeless = screened && this.questionScreening.cannotScreen(projectKey, config);
    if (screened) {
      const handed = this.questionScreening.enqueue(projectKey).catch((err: unknown) => {
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
  }

  readExternal(projectKey: string, ownerUserId: string, itemId: string): ExternalQuestionRead {
    const item = this.ownQuestion(projectKey, ownerUserId, itemId);
    const answerId = questionPayloadOf(item)?.externalAnswerMessageId;
    const message = answerId ? this.ctx.repos.messages.get(answerId) : null;
    return {
      item: this.inbox.get(projectKey, item.id),
      answer: item.state === 'resolved' && item.resolution?.rule !== 'withdrawn' ? answerText(item) : null,
      answer_attachments: message?.attachments ?? [],
    };
  }

  async withdrawExternal(
    projectKey: string,
    origin: ExternalToolOrigin,
    itemId: string,
    reason: string,
  ): Promise<{ itemId: string; state: 'cancelled' }> {
    const note = reason.trim();
    if (!note) throw refuse('The reason is empty.');
    const item = this.ownQuestion(projectKey, origin.ownerUserId, itemId);
    const closed = await this.inbox.closeQuestion(item.id, {
      rule: 'withdrawn',
      by: origin.actor.handle,
      note,
      actor: externalOriginActor(origin),
    });
    if (!closed) throw conflict('inbox_item_closed', `question ${item.id} is not waiting any more`);
    return { itemId: closed.id, state: 'cancelled' };
  }

  /** A question this owner's integrator asked in this project; any other one is as good as missing. */
  private ownQuestion(projectKey: string, ownerUserId: string, itemId: string): InboxItem {
    const item = this.ctx.repos.inbox.get(itemId);
    const own = item ? questionPayloadOf(item)?.externalQuestion : undefined;
    if (
      !item ||
      item.projectKey !== projectKey ||
      item.kind !== 'question' ||
      own?.ownerUserId !== ownerUserId
    )
      throw missing(`Question ${itemId} does not exist in this project.`);
    return item;
  }

  /**
   * A question asked again after the Operator answered, forwarded or closed it (PM-558): the new question
   * goes to the people unscreened, once per earlier question. Returns what the new item records, or null for
   * an ordinary question. Throws `reask_not_allowed` before anything is written.
   */
  private reask(
    projectKey: string,
    member: string,
    input: HumanQuestionInput,
  ): { reason: string; previousItemId: string } | null {
    const reaskOf = input.reaskOf;
    const reason = input.reaskReason?.trim();
    if (reaskOf === undefined && reason === undefined) return null;
    if (!reaskOf || !reason) throw refuse('reask_not_allowed: reask_of and reask_reason go together.');
    const previous = this.ctx.repos.inbox.get(reaskOf);
    if (!previous || previous.projectKey !== projectKey || previous.kind !== 'question')
      throw refuse('reask_not_allowed: there is no such question of yours.');
    if (previous.source !== member)
      throw refuse('reask_not_allowed: only the member who asked may ask again.');
    const outcome = questionPayloadOf(previous)?.screening?.outcome;
    // An Operator answer from its work queue (PM-1009) leaves the screening outcome at `todo`: the rule says it.
    const answeredFromQueue = previous.resolution?.rule === 'operator_answered';
    if (outcome !== 'answered' && outcome !== 'forwarded' && outcome !== 'moot' && !answeredFromQueue)
      throw refuse('reask_not_allowed: the Operator did not answer, forward or close that question.');
    const asked = this.inbox
      .list(projectKey, { kind: 'question' })
      .some((item) => questionPayloadOf(item)?.unscreened?.previousItemId === reaskOf);
    if (asked) throw refuse('reask_not_allowed: that question was already asked again.');
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
      throw refuse(
        'attachments_need_card: files can be named only on a question about a card; give task_key or ask without attachments.',
      );
    const parent = task.parentKey ? this.tasks.find(projectKey, task.parentKey) : null;
    const allowed = [task, ...(parent ? [parent] : [])];
    const scope = parent ? `${task.key} or its parent ${parent.key}` : task.key;
    const found: QuestionAttachment[] = [];
    for (const id of wanted) {
      const row = this.ctx.repos.attachments.get(id);
      if (!row || row.projectKey !== projectKey || row.state !== 'ready')
        throw missing(`attachment_unknown: ${id} is not a file of ${scope}; list_attachments gives the ids.`);
      if (!allowed.some((card) => card.key === row.taskKey))
        throw refuse(
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
    return found;
  }
}

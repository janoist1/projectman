import { ownerHandles, projectDocsOf, RETIRED_OPERATOR_HANDLE } from '@projectman/shared';
import type { InboxItem, ProjectConfig } from '@projectman/shared';
import type { DecisionCandidate, DecisionMark } from '../../contracts';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { DomainError } from '../../kernel';

/** The most characters of a question (title and body) a candidate carries. */
const MAX_CANDIDATE_QUESTION_CHARS = 2000;
const DEFAULT_CANDIDATE_LIMIT = 20;

/**
 * Owner answers on cards that may be decisions (PM-496). A question is a candidate when an owner of the
 * project answered it (through the integrator too), no rule closed it, someone but the Operator asked
 * it, the answer came after the project's `since`, and the owner has not given a verdict on it yet.
 */
export class DecisionCandidates {
  private readonly ctx: DomainContext;

  constructor(deps: { ctx: DomainContext }) {
    this.ctx = deps.ctx;
  }

  /** The candidates, the earliest answer first; `includeOffered` keeps the ones with a verdict already. */
  private find(
    projectKey: string,
    config: ProjectConfig,
    after: string,
    includeOffered = false,
  ): InboxItem[] {
    const owners = ownerHandles(config);
    return this.ctx.repos.inbox.listAnsweredQuestions(projectKey, after, includeOffered).filter((item) => {
      const resolution = item.resolution;
      if (!resolution || resolution.rule || !owners.includes(resolution.by)) return false;
      // An answer the integrator relayed is no decision of the owner (PM-762).
      if (resolution.ownerAnswerRelayed || resolution.integratorTodo) return false;
      // A question the retired Operator asked is no owner decision either.
      return this.askerOf(item) !== RETIRED_OPERATOR_HANDLE;
    });
  }

  /** The member who asked: the item's session, else the member that raised it. */
  private askerOf(item: InboxItem): string | null {
    return (
      (item.sessionId ? this.ctx.repos.sessions.get(item.sessionId)?.member : null) ?? item.source ?? null
    );
  }

  private since(projectKey: string): string {
    return this.ctx.repos.decisionOffers.state(projectKey)?.since ?? '';
  }

  /** The candidates for the Operator, at most `limit`; the call counts as a look (`listed_at`). */
  list(
    projectKey: string,
    config: ProjectConfig,
    limit = DEFAULT_CANDIDATE_LIMIT,
  ): { candidates: DecisionCandidate[]; more: boolean } {
    if (!projectDocsOf(config)?.decisions)
      throw new DomainError('docs_not_configured', 'the project has no decision log file set', {
        status: 409,
      });
    const found = this.find(projectKey, config, this.since(projectKey));
    this.ctx.repos.decisionOffers.markListed(projectKey, isoNow(this.ctx));
    return {
      candidates: found.slice(0, limit).map((item) => this.view(item)),
      more: found.length > limit,
    };
  }

  /**
   * How many candidates the Operator has not looked at: the ones answered after the later of `since`
   * and its last look. 0 when the project has no decision log.
   */
  unseen(projectKey: string, config: ProjectConfig): number {
    if (!projectDocsOf(config)?.decisions) return 0;
    const state = this.ctx.repos.decisionOffers.state(projectKey);
    const after = [state?.since ?? '', state?.listedAt ?? ''].reduce((a, b) => (a > b ? a : b));
    return this.find(projectKey, config, after).length;
  }

  /**
   * The owner's verdicts, all or nothing: an unknown or not-candidate item refuses the whole call
   * (`not_found`). An item that was marked before can be marked again.
   */
  mark(projectKey: string, config: ProjectConfig, requestId: string, marks: DecisionMark[]): number {
    const stray = marks.find((mark) => mark.decision !== undefined && mark.verdict !== 'recorded');
    if (stray)
      throw new DomainError(
        'invalid_request',
        `decision goes only with the verdict recorded: ${stray.item_id}`,
      );
    const candidates = new Set(
      this.find(projectKey, config, this.since(projectKey), true).map((item) => item.id),
    );
    const unknown = marks.filter((mark) => !candidates.has(mark.item_id));
    if (unknown.length)
      throw new DomainError(
        'not_found',
        `not a decision candidate: ${unknown.map((mark) => mark.item_id).join(', ')}`,
        { status: 404 },
      );
    const at = isoNow(this.ctx);
    this.ctx.unitOfWork(() => {
      for (const mark of marks)
        this.ctx.repos.decisionOffers.upsert({
          projectKey,
          itemId: mark.item_id,
          verdict: mark.verdict,
          decision: mark.verdict === 'recorded' ? (mark.decision ?? null) : null,
          requestId,
          decidedAt: at,
        });
    });
    return marks.length;
  }

  private view(item: InboxItem): DecisionCandidate {
    const resolution = item.resolution!;
    const task = item.taskKey ? this.ctx.repos.tasks.get(item.taskKey) : null;
    const question = [item.title, item.body].filter(Boolean).join('\n\n');
    return {
      item_id: item.id,
      task_key: item.taskKey,
      task_title: task?.title ?? null,
      asked_by: this.askerOf(item),
      asked_at: item.createdAt,
      question: Array.from(question).slice(0, MAX_CANDIDATE_QUESTION_CHARS).join(''),
      answer: {
        option: item.options.find((option) => option.id === resolution.optionId)?.label ?? null,
        note: resolution.note,
      },
      answered_by: resolution.by,
      answered_at: resolution.at,
      via_integrator: resolution.via === 'integrator',
    };
  }
}

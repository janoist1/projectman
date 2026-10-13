import {
  formatInjectedTeamMessage,
  isOnLeave,
  isWorkPaused,
  operatorOf,
  questionPayloadOf,
} from '@projectman/shared';
import type { InboxItem, ProjectConfig } from '@projectman/shared';
import type { Admission, AutomaticStart, StartSpec } from './admission';
import { isoNow } from './context';
import type { DomainContext } from './context';
import type { InboxService } from './inbox';
import type { MessageDelivery } from './messaging';
import type { ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';

/** The first lines of the notice the Operator gets for the questions it screens. */
const SCREENING_NOTICE =
  'Projectman question screening. AI members asked questions meant for people. Handle every one of them now ' +
  'with screen_question (item_id, outcome, note; answered also needs answer, forwarded forward_to, todo todo). ' +
  'Your instructions say which outcome fits. Start or move nothing on the board while you screen. ' +
  'A question you leave alone goes to the people when its `until` time comes.';

/**
 * The Operator looks at an AI member's question before any person sees it (PM-558, PM-556). A new question
 * waits in the inbox state `screening`; this wakes the Operator for it, through admission like every
 * server-started session, and gives the question to the people (`fallback`) when the Operator cannot take
 * it (`unavailable`, at once) or does not settle it in time (`timeout`, `payload.screening.until`).
 */
export class QuestionScreening {
  private readonly waking = new Set<string>();
  private readonly again = new Set<string>();
  private readonly firstDeliveries = new Map<string, Promise<void>>();
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    sessions: SessionOrchestrator;
    admission: Admission;
    delivery: MessageDelivery;
    inbox: InboxService;
    /** False: no question is screened (tests that are not about screening). */
    enabled: boolean;
  };

  constructor(deps: QuestionScreening['deps']) {
    this.deps = deps;
  }

  /** Whether new questions of AI members go to the Operator first at all. */
  get enabled(): boolean {
    return this.deps.enabled;
  }

  /**
   * Whether the Operator cannot take questions now: nobody to ask, AI work off, on leave, or the team paused.
   * The same rule the fallback uses; `ask_human` waits for the release only when this holds.
   */
  cannotScreen(projectKey: string, config: ProjectConfig): boolean {
    const operator = operatorOf(config);
    return (
      !operator ||
      !config.team.limits.aiEnabled ||
      isOnLeave(operator) ||
      isWorkPaused(this.deps.ctx.repos.pauses.open(), projectKey)
    );
  }

  /** A question was put into screening: the Operator gets it, or the people do at once when it cannot. */
  async enqueue(projectKey: string): Promise<void> {
    await this.deliver(projectKey);
  }

  /** Timer and startup: releases the questions whose time is up, then gives the Operator what it has not got. */
  async sweep(): Promise<void> {
    const { ctx, projects } = this.deps;
    for (const { key } of projects.summaries()) {
      const now = ctx.now().getTime();
      for (const item of this.screening(key))
        if (Date.parse(this.untilOf(item)) <= now) await this.release(item, 'timeout');
      await this.deliver(key);
    }
  }

  rebuild(spec: Extract<StartSpec, { kind: 'question_screening' }>): AutomaticStart | null {
    return this.undelivered(spec.projectKey).length ? this.start(spec.projectKey) : null;
  }

  private screening(projectKey: string): InboxItem[] {
    return this.deps.ctx.repos.inbox.list(projectKey, { state: 'screening', kind: 'question' });
  }

  private undelivered(projectKey: string): InboxItem[] {
    return this.screening(projectKey).filter((item) => !questionPayloadOf(item)?.screening?.deliveredAt);
  }

  private untilOf(item: InboxItem): string {
    return questionPayloadOf(item)?.screening?.until ?? item.createdAt;
  }

  private async release(item: InboxItem, fallback: 'timeout' | 'unavailable'): Promise<void> {
    await this.deps.inbox.releaseScreened(item.id, { fallback }).catch((err: unknown) => {
      this.deps.ctx.logger.warn({ err, inboxItemId: item.id }, 'could not release a screened question');
    });
  }

  private async releaseAll(projectKey: string): Promise<void> {
    for (const item of this.screening(projectKey)) await this.release(item, 'unavailable');
  }

  /**
   * Wakes the Operator for the questions it has not got. When it cannot be woken now (nobody to ask, AI work
   * off, on leave, the team paused, admission defers the start, or the start fails), the questions go to the
   * people at once: nothing waits ten minutes for an Operator that is not coming.
   */
  private async deliver(projectKey: string): Promise<void> {
    if (this.waking.has(projectKey)) {
      this.again.add(projectKey);
      return;
    }
    this.waking.add(projectKey);
    try {
      do {
        this.again.delete(projectKey);
        if (!this.undelivered(projectKey).length) continue;
        if (await this.unavailable(projectKey)) {
          await this.releaseAll(projectKey);
          continue;
        }
        try {
          const outcome = await this.deps.admission.attempt(this.start(projectKey));
          // The CLI may still wait for its first input; admission's lock is free by now.
          await this.firstDeliveries.get(projectKey);
          if (outcome.kind === 'deferred') await this.releaseAll(projectKey);
        } catch (err) {
          this.deps.ctx.logger.warn(
            { err, projectKey },
            'could not give the Operator the screened questions',
          );
          await this.releaseAll(projectKey);
        } finally {
          this.firstDeliveries.delete(projectKey);
        }
      } while (this.again.has(projectKey));
    } finally {
      this.waking.delete(projectKey);
    }
  }

  private async unavailable(projectKey: string): Promise<boolean> {
    return this.cannotScreen(projectKey, await this.deps.projects.config(projectKey));
  }

  private start(projectKey: string): AutomaticStart {
    const { ctx, projects, sessions, admission, delivery } = this.deps;
    return {
      key: `question-screening:${projectKey}`,
      projectKey,
      taskKey: null,
      spec: () => ({ kind: 'question_screening', projectKey }),
      stillValid: () => this.undelivered(projectKey).length > 0,
      waitsFor: () => operatorOf(projects.cachedConfig(projectKey)!)?.handle,
      retry: () => this.deliver(projectKey),
      log: {
        deferred: 'question screening start deferred',
        retryFailed: 'question screening retry failed',
        fields: () => ({ projectKey }),
      },
      run: async () => {
        const config = await projects.config(projectKey);
        const member = operatorOf(config);
        if (!member) return;
        const items = this.undelivered(projectKey);
        if (!items.length) return;
        const text = `${SCREENING_NOTICE}\n${items.map((item) => JSON.stringify(noticeOf(item))).join('\n')}`;
        const workItem = { type: 'general' } as const;
        const markDelivered = () =>
          ctx.unitOfWork(() => {
            const at = isoNow(ctx);
            for (const item of items) {
              const current = ctx.repos.inbox.get(item.id);
              if (current?.state !== 'screening') continue;
              const screening = (current.payload.screening ?? {}) as Record<string, unknown>;
              ctx.repos.inbox.updatePayload(
                item.id,
                { ...current.payload, screening: { ...screening, deliveredAt: at } },
                at,
              );
            }
          });
        const running = sessions.findRunning(projectKey, member.handle, workItem);
        if (running && !sessions.isPaused(running)) {
          if (!(await delivery.notice(running, 'projectman', text, null)))
            throw new Error('question screening delivery failed');
        } else {
          let firstInput: Promise<boolean> | undefined;
          await delivery.startAndDeliver(projectKey, member.handle, workItem, async (messages) => {
            const result = await admission.start({
              config,
              member,
              workItem,
              cause: { kind: 'question_screening' },
              // The Operator's conversation with the owners is not a card's work: it takes no capacity.
              capacity: false,
              messages: [...messages, formatInjectedTeamMessage('projectman', text, null)],
            });
            firstInput = result.firstInput;
            return result;
          });
          const delivered = firstInput!.then((typed) => {
            if (!typed) throw new Error('question screening first input was not delivered');
            markDelivered();
          });
          // A rejection handler goes on before the admission attempt releases its lock.
          void delivered.catch(() => undefined);
          this.firstDeliveries.set(projectKey, delivered);
          return;
        }
        markDelivered();
      },
    };
  }
}

/** One question as the Operator's notice carries it. */
function noticeOf(item: InboxItem) {
  const payload = questionPayloadOf(item);
  return {
    id: item.id,
    asker: item.source,
    taskKey: item.taskKey,
    title: item.title,
    question: payload?.question ?? item.title,
    details: payload?.details ?? null,
    options: payload?.options ?? [],
    recommended: payload?.recommended ?? null,
    until: payload?.screening?.until ?? null,
  };
}

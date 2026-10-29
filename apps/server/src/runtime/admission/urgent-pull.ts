import {
  chooseDeveloper,
  complexityOf,
  developmentStage,
  isWorkPaused,
  pullCandidates,
  pullSourceStage,
  reachingDevelopers,
  stageDevelopers,
  stageOwners,
  tempMaxPointsOf,
} from '@projectman/shared';
import type { StagePull } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import { DomainError } from '../../kernel';
import { startContext } from '../../core/tasks';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { Admission, UrgentPulling } from './admission';
import { isDeferrable } from './rules';
import type { SeniorWaits } from './senior-waits';
import type { WorkStarts } from './work-starts';

const URGENT_PULL: StagePull = { reason: 'urgent' };

/**
 * The urgent pull (PM-436): a free developer takes a ready (Indulhat) urgent card without anybody moving it.
 * A round runs at the end of every `Admission.retryDeferred`
 * (after the loop, without the admission lock: `WorkStarts.pull` takes it for each card it starts), so every
 * event that retries the deferred starts also frees developers for the pull. Rounds do not overlap: one that
 * is asked for while another runs makes the running one go once more.
 *
 * Per project nothing is pulled while AI work is off, the project or the instance is paused, or the
 * pipeline has no queue before the development stage. A developer is free when they own the development
 * stage (not a temp worker, not on leave), have capacity, and no stored deferred start waits for them (that
 * one goes first). The candidates (`pullCandidates`) are taken in order and the developer is picked as for any
 * start (`chooseDeveloper`), so a card is never given to a developer whose limit is below its points
 * while one that reaches it is only busy; one developer takes at most one
 * card per round. A refusal because of the card moves on to the next card; one because of the developer (capacity,
 * provider, engine, limits, disk, pause) leaves the developer out of the round. Refusals are logged at debug
 * level only and write no timeline, so the 30-second round does not fill the log.
 */
export class UrgentPull implements UrgentPulling {
  private readonly ctx: DomainContext;
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly tasks: Pick<TaskService, 'readSchedulingTasks' | 'find'>;
  private readonly admission: Pick<Admission, 'freeDevelopers'>;
  private readonly seniorWaits: Pick<SeniorWaits, 'decisionFor'>;
  private readonly starts: Pick<WorkStarts, 'pull'>;
  private active: Promise<void> | null = null;
  private again = false;

  constructor(deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'config'>;
    tasks: Pick<TaskService, 'readSchedulingTasks' | 'find'>;
    admission: Pick<Admission, 'freeDevelopers'>;
    seniorWaits: Pick<SeniorWaits, 'decisionFor'>;
    starts: Pick<WorkStarts, 'pull'>;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.admission = deps.admission;
    this.seniorWaits = deps.seniorWaits;
    this.starts = deps.starts;
  }

  /** One round over every project; a round asked for while one runs makes it go once more. */
  run(): Promise<void> {
    if (this.active) {
      this.again = true;
      return this.active;
    }
    this.active = (async () => {
      try {
        do {
          this.again = false;
          await this.round();
        } while (this.again);
      } finally {
        this.active = null;
      }
    })();
    return this.active;
  }

  private async round(): Promise<void> {
    for (const { key: projectKey } of this.ctx.repos.projects.list()) {
      try {
        await this.pullFor(projectKey);
      } catch (err) {
        this.ctx.logger.warn({ err, projectKey }, 'urgent pull failed for a project');
      }
    }
  }

  private async pullFor(projectKey: string): Promise<void> {
    const config = await this.projects.config(projectKey).catch(() => null);
    if (!config?.team.limits.aiEnabled) return;
    if (isWorkPaused(this.ctx.repos.pauses.open(), projectKey)) return;
    const source = pullSourceStage(config);
    const development = developmentStage(config);
    if (!source || !development) return;
    // Nobody free: no card is read (PM-770). Then the pull candidates are read, with the subtasks and
    // prerequisites the unchanged shared rules look at.
    let free = this.admission.freeDevelopers(config, development.id);
    if (free.length === 0) return;
    const pullable = this.tasks.readSchedulingTasks(projectKey, { kind: 'pull', stageId: source.id });
    const candidates = pullCandidates({ config, tasks: startContext(this.tasks, projectKey, pullable) });
    if (candidates.length === 0) return;
    const owners = stageOwners(config, development);
    const developers = stageDevelopers(config, development).filter((developer) =>
      owners.includes(developer.handle),
    );
    for (const card of candidates) {
      if (free.length === 0) break;
      const points = complexityOf(card);
      const pick = chooseDeveloper({
        points,
        labels: card.labels,
        anyDecided: this.seniorWaits.decisionFor(projectKey, card.key)?.decision === 'any',
        reaching: reachingDevelopers(developers, points, card.labels),
        free,
        tempMaxPoints: tempMaxPointsOf(config),
      });
      // The card waits for a developer whose limit reaches its points, or nobody can take it: the next card.
      if (pick.kind !== 'member') {
        this.ctx.logger.debug({ taskKey: card.key, pick: pick.kind }, 'urgent pull skipped a card');
        continue;
      }
      const developer = pick.handle;
      let taken = false;
      let developerOut = false;
      try {
        taken = await this.starts.pull({
          projectKey,
          taskKey: card.key,
          from: source.id,
          to: development.id,
          developer,
          pulled: URGENT_PULL,
        });
      } catch (err) {
        // The card is the developer's already when only the start of their session failed afterwards.
        const now = this.tasks.find(projectKey, card.key);
        if (now?.assignee === developer && now.stageId === development.id) {
          taken = true;
          this.ctx.logger.warn({ err, taskKey: card.key, developer }, 'a pulled card could not be started');
        } else if (isDeferrable(err)) {
          developerOut = true;
          this.ctx.logger.debug(
            { taskKey: card.key, developer, code: err.code },
            'urgent pull refused because of the developer',
          );
        } else if (err instanceof DomainError) {
          this.ctx.logger.debug(
            { taskKey: card.key, developer, code: err.code },
            'urgent pull refused because of the card',
          );
        } else {
          developerOut = true;
          this.ctx.logger.warn({ err, taskKey: card.key, developer }, 'urgent pull failed');
        }
      }
      if (taken) {
        this.ctx.logger.info(
          { taskKey: card.key, developer, reason: URGENT_PULL.reason },
          'a card was pulled into development',
        );
      }
      if (taken || developerOut) free = free.filter((candidate) => candidate.handle !== developer);
    }
  }
}

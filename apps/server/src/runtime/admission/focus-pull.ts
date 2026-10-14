import {
  developerLevelOf,
  developmentStage,
  isHandleOnLeave,
  isSenior,
  isWorkPaused,
  pickDeveloper,
  pullCandidates,
  pullSourceStage,
  seniorsOf,
  stageOwners,
  startClass,
} from '@projectman/shared';
import type {
  AiMemberConfig,
  DeveloperCandidate,
  FocusPlace,
  ProjectConfig,
  StagePull,
  Task,
} from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import { DomainError } from '../../kernel';
import type { ProjectFocusService } from '../../core/tasks';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { Admission, FocusPulling } from './admission';
import { isDeferrable } from './rules';
import type { SeniorWaits } from './senior-waits';
import type { WorkStarts } from './work-starts';

/**
 * The focus pull (PM-427): a free developer takes a ready (Indulhat) urgent card, else the next card the
 * project's focus covers, without anybody moving it. A round runs at the end of every `Admission.retryDeferred`
 * (after the loop, without the admission lock: `WorkStarts.pull` takes it for each card it starts), so every
 * event that retries the deferred starts also frees developers for the pull. Rounds do not overlap: one that
 * is asked for while another runs makes the running one go once more.
 *
 * Per project nothing is pulled while AI work is off, the project or the instance is paused, or the
 * pipeline has no queue before the development stage. A developer is free when they own the development
 * stage (not a temp worker, not on leave), have capacity, and no stored deferred start waits for them (that
 * one goes first). The candidates (`pullCandidates`) are taken in order and the developer is picked as for any
 * start (`pickDeveloper`), so a Senior card is never given to someone else; one developer takes at most one
 * card per round. A refusal because of the card moves on to the next card; one because of the developer (capacity,
 * provider, engine, limits, disk, pause) leaves the developer out of the round. Refusals are logged at debug
 * level only and write no timeline, so the 30-second round does not fill the log.
 */
export class FocusPull implements FocusPulling {
  private readonly ctx: DomainContext;
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly tasks: Pick<TaskService, 'list' | 'find'>;
  private readonly focus: Pick<ProjectFocusService, 'places'>;
  private readonly admission: Pick<Admission, 'memberLoad' | 'membersWaitedFor'>;
  private readonly seniorWaits: Pick<SeniorWaits, 'decisionFor'>;
  private readonly starts: Pick<WorkStarts, 'pull'>;
  private active: Promise<void> | null = null;
  private again = false;

  constructor(deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'config'>;
    tasks: Pick<TaskService, 'list' | 'find'>;
    focus: Pick<ProjectFocusService, 'places'>;
    admission: Pick<Admission, 'memberLoad' | 'membersWaitedFor'>;
    seniorWaits: Pick<SeniorWaits, 'decisionFor'>;
    starts: Pick<WorkStarts, 'pull'>;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.focus = deps.focus;
    this.admission = deps.admission;
    this.seniorWaits = deps.seniorWaits;
    this.starts = deps.starts;
  }

  /** Key -> place of the project's open cards the focus covers. */
  places(projectKey: string): ReadonlyMap<string, FocusPlace> {
    return this.focus.places(projectKey);
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
        this.ctx.logger.warn({ err, projectKey }, 'focus pull failed for a project');
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
    const tasks = this.tasks.list(projectKey);
    const places = this.focus.places(projectKey);
    const candidates = pullCandidates({ config, tasks, places });
    if (candidates.length === 0) return;
    let free = this.freeDevelopers(config, development.id);
    if (free.length === 0) return;
    const owners = stageOwners(config, development);
    const seniors = seniorsOf(config, development)
      .map((senior) => senior.handle)
      .filter((handle) => owners.includes(handle));
    for (const card of candidates) {
      if (free.length === 0) break;
      const pick = pickDeveloper({
        level: developerLevelOf(card),
        anyDecided: this.seniorWaits.decisionFor(projectKey, card.key)?.decision === 'any',
        seniors,
        free,
      });
      // The card waits for a Senior, or nobody can take it: the next card.
      if (pick.kind !== 'member') {
        this.ctx.logger.debug({ taskKey: card.key, pick: pick.kind }, 'focus pull skipped a card');
        continue;
      }
      const developer = pick.handle;
      const pulled = pullOf(card, places, tasks);
      let taken = false;
      let developerOut = false;
      try {
        taken = await this.starts.pull({
          projectKey,
          taskKey: card.key,
          from: source.id,
          to: development.id,
          developer,
          pulled,
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
            'focus pull refused because of the developer',
          );
        } else if (err instanceof DomainError) {
          this.ctx.logger.debug(
            { taskKey: card.key, developer, code: err.code },
            'focus pull refused because of the card',
          );
        } else {
          developerOut = true;
          this.ctx.logger.warn({ err, taskKey: card.key, developer }, 'focus pull failed');
        }
      }
      if (taken) {
        this.ctx.logger.info(
          { taskKey: card.key, developer, reason: pulled.reason },
          'a card was pulled into development',
        );
      }
      if (taken || developerOut) free = free.filter((candidate) => candidate.handle !== developer);
    }
  }

  /** The AI owners of the development stage who take a card now (see the class comment). */
  private freeDevelopers(config: ProjectConfig, stageId: string): DeveloperCandidate[] {
    const stage = config.pipeline.stages.find((s) => s.id === stageId);
    if (!stage) return [];
    const owners = new Set(stageOwners(config, stage));
    const waitedFor = this.admission.membersWaitedFor(config.project.key);
    const free: DeveloperCandidate[] = [];
    config.team.members.forEach((member, index) => {
      if (member.kind !== 'ai' || member.temp || !owners.has(member.handle)) return;
      if (isHandleOnLeave(config, member.handle) || waitedFor.has(member.handle)) return;
      const load = this.admission.memberLoad(config, member.handle);
      if (load >= member.capacity) return;
      free.push(candidateOf(member, index, load));
    });
    return free;
  }
}

function candidateOf(member: AiMemberConfig, index: number, load: number): DeveloperCandidate {
  return { handle: member.handle, senior: isSenior(member), temp: false, load, index };
}

/** Why the card is pulled: it is urgent, or the focus item that covers it (the card itself, or the one it is under). */
function pullOf(card: Task, places: ReadonlyMap<string, FocusPlace>, tasks: readonly Task[]): StagePull {
  const cls = startClass(card, places);
  if (cls.kind !== 'focus') return { reason: 'urgent' };
  const via = places.get(card.key)?.via ?? card.key;
  const item = via === card.key ? card : tasks.find((task) => task.key === via);
  return { reason: 'focus', position: cls.position, key: via, title: item?.title ?? via };
}

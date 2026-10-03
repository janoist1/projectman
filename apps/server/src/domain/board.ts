import { DEFAULT_AGENT_PROVIDER, labelHolders, resolvedStages } from '@projectman/shared';
import type { BoardView } from '@projectman/shared';
import type { InboxService } from './inbox';
import type { MemberService } from './members';
import type { PauseService } from './pause';
import type { PlanUsageCache } from './plan-usage';
import type { ProjectService } from './projects';
import type { TaskService } from './tasks';
import { isClient, visibleTasks } from './visibility';
import type { Viewer } from './visibility';

/** A project's board as one member sees it. */
export class BoardService {
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly members: MemberService;
  private readonly inbox: InboxService;
  private readonly planUsage: Pick<PlanUsageCache, 'peek'>;
  private readonly pauses: Pick<PauseService, 'projectView'>;

  constructor(deps: {
    projects: ProjectService;
    tasks: TaskService;
    members: MemberService;
    inbox: InboxService;
    planUsage: Pick<PlanUsageCache, 'peek'>;
    pauses: Pick<PauseService, 'projectView'>;
  }) {
    this.pauses = deps.pauses;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.members = deps.members;
    this.inbox = deps.inbox;
    this.planUsage = deps.planUsage;
  }

  /**
   * Columns with their stages, labels with who may set them, the tasks the viewer may see, the
   * roster, the viewer's open inbox count and the plan usage of every provider the team's AI
   * members run on (known from earlier probes; hidden from clients).
   */
  async view(projectKey: string, viewer: Viewer): Promise<BoardView> {
    const { config } = await this.projects.load(projectKey);
    const providers = [
      ...new Set(
        config.team.members.flatMap((m) => (m.kind === 'ai' ? [m.provider ?? DEFAULT_AGENT_PROVIDER] : [])),
      ),
    ];
    const planUsageByProvider = Object.fromEntries(
      providers.map((provider) => [provider, isClient(viewer) ? null : this.planUsage.peek(provider)]),
    );
    return {
      aiEnabled: config.team.limits.aiEnabled,
      project: this.projects.summary(projectKey),
      columns: config.pipeline.columns.map((column) => ({
        ...column,
        stageIds: config.pipeline.stages.filter((s) => s.columnId === column.id).map((s) => s.id),
      })),
      stages: resolvedStages(config),
      labels: config.pipeline.labels.map((label) => ({ ...label, holders: labelHolders(config, label) })),
      tasks: visibleTasks(viewer, this.tasks.list(projectKey)),
      members: this.members.rosterForViewer(config, viewer),
      openInboxCount: this.inbox.countOpenFor(projectKey, viewer.handle),
      planUsage: planUsageByProvider.claude ?? null,
      planUsageByProvider,
      // Which sessions are held is the team's business: a client sees none of it.
      ...(isClient(viewer) ? {} : { pause: this.pauses.projectView(projectKey) }),
    };
  }
}

import { coordinationActorRefusal, coordinationMemberOf, LoopTriageFacts } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import { conflict, forbidden, invalid } from '../../kernel';
import type { LoopTriageActions } from './ports';
import type { OperatorSignals } from './signals';

/** PM filtering is report-only: it neither grants an owner request nor resolves a human decision. */
export class LoopTriages {
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    signals: OperatorSignals;
    actions: LoopTriageActions;
  };
  constructor(deps: LoopTriages['deps']) {
    this.deps = deps;
  }

  async report(input: { projectKey: string; taskKey: string; facts: LoopTriageFacts }): Promise<{
    state: 'delivered' | 'queued' | 'unavailable' | 'failed';
    signalId: string | null;
  }> {
    let signalId: string | null = null;
    try {
      const config = await this.deps.projects.config(input.projectKey);
      const member = coordinationMemberOf(config);
      if (!member || !config.team.limits.aiEnabled) return { state: 'unavailable', signalId };
      const facts = LoopTriageFacts.parse(input.facts);
      const signal = this.deps.signals.raise({
        projectKey: input.projectKey,
        taskKey: input.taskKey,
        kind: 'loop_suspected',
        caseKey: `loop_suspected:${facts.loopId}:${facts.generation}`,
        subject: JSON.stringify(facts),
      });
      signalId = signal.id;
      if (signal.deliveredAt && signal.deliveredTo === member.handle) return { state: 'delivered', signalId };
      await this.deps.signals.deliver(input.projectKey);
      const current = this.deps.ctx.repos.operatorSignals.get(signal.id);
      return {
        state: current?.deliveredAt && current.deliveredTo === member.handle ? 'delivered' : 'queued',
        signalId,
      };
    } catch (err) {
      this.deps.ctx.logger.warn({ err, taskKey: input.taskKey }, 'could not report a suspected loop');
      return { state: 'failed', signalId };
    }
  }

  async assess(input: {
    projectKey: string;
    signalId: string;
    by: string;
    outcome: 'progress' | 'loop';
    note: string;
    evidenceIds: string[];
  }) {
    const { ctx, projects } = this.deps;
    const config = await projects.config(input.projectKey);
    if (coordinationActorRefusal(config, { kind: 'ai', handle: input.by }))
      throw forbidden('project_manager_only', 'only the selected PM may assess a loop');
    const signal = ctx.repos.operatorSignals.get(input.signalId);
    if (!signal || signal.projectKey !== input.projectKey)
      throw invalid('invalid_request', 'unknown signal in this project');
    if (signal.kind !== 'loop_suspected' || !signal.taskKey)
      throw invalid('invalid_request', 'a loop assessment requires a loop signal');
    const parsed = LoopTriageFacts.safeParse(signal.subject ? JSON.parse(signal.subject) : null);
    if (!parsed.success) throw invalid('invalid_request', 'invalid loop facts');
    const facts = parsed.data;
    const loop = ctx.repos.taskLoops.get(facts.loopId);
    const repeated = loop?.triage?.generation === facts.generation && loop.triage.assessed?.by === input.by;
    if (
      !signal.deliveredAt ||
      signal.deliveredTo !== input.by ||
      signal.messageId ||
      (!repeated && (signal.resolvedAt || !['pending', 'open'].includes(signal.state))) ||
      !loop ||
      loop.projectKey !== input.projectKey ||
      loop.taskKey !== signal.taskKey ||
      loop.triage?.generation !== facts.generation
    )
      throw conflict('operator_signal_closed', 'the loop signal is no longer current');
    return this.deps.actions.assess({
      projectKey: input.projectKey,
      taskKey: signal.taskKey,
      loopId: facts.loopId,
      generation: facts.generation,
      by: input.by,
      outcome: input.outcome,
      note: input.note,
      evidenceIds: input.evidenceIds,
    });
  }
}

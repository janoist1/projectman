import type { ProjectConfig } from './schema';

export interface ConfigIssue {
  /** Stable machine code; the UI maps it to a translated message. */
  code:
    | 'duplicate_handle'
    | 'no_owner'
    | 'unknown_member'
    | 'approver_not_human'
    | 'release_without_human_approval'
    | 'unknown_column'
    | 'first_stage_not_queue'
    | 'last_stage_not_done'
    | 'duplicate_stage'
    | 'sponsor_not_human'
    | 'unknown_repo';
  path: string;
  detail?: string;
}

/**
 * Rules that always hold, whoever changes the configuration (a human or the system agent):
 * - every handle is unique and at least one owner exists;
 * - stage owners, gate approvers and AI sponsors refer to existing members;
 * - approvers and sponsors are humans (an AI can never approve a gate);
 * - every release stage requires a human approval.
 */
export function validateProjectConfig(config: ProjectConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const members = new Map(config.team.members.map((m) => [m.handle, m]));

  const seen = new Set<string>();
  config.team.members.forEach((m, i) => {
    if (seen.has(m.handle))
      issues.push({ code: 'duplicate_handle', path: `team.members[${i}]`, detail: m.handle });
    seen.add(m.handle);
    if (m.kind === 'ai') {
      const sponsor = members.get(m.sponsor);
      if (!sponsor || sponsor.kind !== 'human') {
        issues.push({ code: 'sponsor_not_human', path: `team.members[${i}].sponsor`, detail: m.sponsor });
      }
    }
  });

  if (!config.team.members.some((m) => m.kind === 'human' && m.access === 'owner')) {
    issues.push({ code: 'no_owner', path: 'team.members' });
  }

  const columns = new Set(config.pipeline.columns.map((c) => c.id));
  const stageIds = new Set<string>();
  config.pipeline.stages.forEach((stage, i) => {
    const path = `pipeline.stages[${i}]`;
    if (stageIds.has(stage.id)) issues.push({ code: 'duplicate_stage', path, detail: stage.id });
    stageIds.add(stage.id);
    if (!columns.has(stage.columnId)) issues.push({ code: 'unknown_column', path, detail: stage.columnId });
    stage.owners.forEach((h) => {
      if (!members.has(h)) issues.push({ code: 'unknown_member', path: `${path}.owners`, detail: h });
    });
    const approvals = (stage.gate?.conditions ?? []).filter((c) => c.type === 'human_approval');
    approvals.forEach((c) => {
      c.approvers.forEach((h) => {
        const m = members.get(h);
        if (!m) issues.push({ code: 'unknown_member', path: `${path}.gate`, detail: h });
        else if (m.kind !== 'human')
          issues.push({ code: 'approver_not_human', path: `${path}.gate`, detail: h });
      });
    });
    if (stage.kind === 'release' && approvals.length === 0) {
      issues.push({ code: 'release_without_human_approval', path });
    }
  });

  const stages = config.pipeline.stages;
  if (stages[0] && stages[0].kind !== 'queue')
    issues.push({ code: 'first_stage_not_queue', path: 'pipeline.stages[0]' });
  const last = stages[stages.length - 1];
  if (last && last.kind !== 'done')
    issues.push({ code: 'last_stage_not_done', path: `pipeline.stages[${stages.length - 1}]` });

  return issues;
}

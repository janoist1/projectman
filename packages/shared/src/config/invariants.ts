import { DUTIES, DUTY_IDS } from '../domain/duty';
import { dutyMembers } from './duties';
import { gateAcceptsCondition } from './gates';
import { labelDefinition, labelHolders } from './labels';
import { isHumanOnlyLabel } from '../domain/label';
import { DEFAULT_AGENT_PROVIDER } from '../domain/member';
import { permissionModeFitsProvider } from '../domain/provider-model';
import { holdersAllow, isBuiltInRole, roleHolders } from '../domain/role';
import type { ProjectConfig } from './schema';

export interface ConfigIssue {
  /** Stable machine code; the UI maps it to a translated message. */
  code:
    | 'missing_duty_holder'
    | 'recommended_duty_unfilled'
    | 'duplicate_handle'
    | 'no_owner'
    | 'unknown_member'
    | 'unknown_label'
    | 'duplicate_label'
    | 'missing_label_setter'
    | 'release_without_human_approval'
    | 'release_approval_needs_duty'
    | 'unknown_column'
    | 'duplicate_column'
    | 'first_stage_not_queue'
    | 'last_stage_not_done'
    | 'duplicate_stage'
    | 'duplicate_repo'
    | 'sponsor_not_human'
    | 'codex_bypass_not_allowed'
    | 'unknown_role'
    | 'role_not_for_ai'
    | 'role_not_for_human'
    | 'custom_role_shadows_builtin'
    | 'duplicate_role';
  /** Absent in older clients means error. */
  severity?: 'error' | 'warning';
  path: string;
  detail?: string;
}

/**
 * Rules that always hold, whoever changes the configuration (a human or the system agent):
 * - every handle is unique and at least one owner exists;
 * - stage owners, the members a label names as setters and AI sponsors refer to existing
 *   members; sponsors are humans;
 * - an AI member's permission mode is one its provider allows: a Codex member never runs in
 *   `bypassPermissions` (decision 19);
 * - repository names, column ids, stage ids and label ids are unique, every stage sits in an
 *   existing column, the first stage is a queue and the last one done;
 * - every label a gate requires is defined and, unless the system sets it, someone may set it;
 *   stage and gate duties have holders;
 * - every release stage requires an approval: a label only humans may set (so an AI can never
 *   approve), with at least one human who may set it; and the approval of a release is the release
 *   approval duty's alone (decision 19), so a label any human, named members or another duty's
 *   holders may set is refused on a release gate;
 * - every role a member holds (and the temp workers' role) is a built-in or custom role that
 *   the member's kind may hold; custom role ids are unique and never reuse a built-in id.
 * Unfilled recommended duties are warnings, never errors.
 */
export function validateProjectConfig(config: ProjectConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const members = new Map(config.team.members.map((m) => [m.handle, m]));

  const customIds = new Set<string>();
  config.team.roles.forEach((role, i) => {
    const path = `team.roles[${i}].id`;
    if (isBuiltInRole(role.id)) issues.push({ code: 'custom_role_shadows_builtin', path, detail: role.id });
    else if (customIds.has(role.id)) issues.push({ code: 'duplicate_role', path, detail: role.id });
    customIds.add(role.id);
  });
  const checkRole = (role: string, kind: 'human' | 'ai', path: string) => {
    const holders = roleHolders(role, config.team.roles, config.team.roleOverrides);
    if (holders === null) issues.push({ code: 'unknown_role', path, detail: role });
    else if (!holdersAllow(holders, kind)) {
      issues.push({ code: kind === 'ai' ? 'role_not_for_ai' : 'role_not_for_human', path, detail: role });
    }
  };

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
      if (!permissionModeFitsProvider(m.provider ?? DEFAULT_AGENT_PROVIDER, m.permissionMode)) {
        issues.push({ code: 'codex_bypass_not_allowed', path: `team.members[${i}].permissionMode` });
      }
      checkRole(m.role, 'ai', `team.members[${i}].role`);
    } else {
      const held = new Set<string>();
      m.roles.forEach((role, j) => {
        const path = `team.members[${i}].roles[${j}]`;
        if (held.has(role)) issues.push({ code: 'duplicate_role', path, detail: role });
        held.add(role);
        checkRole(role, 'human', path);
      });
    }
  });
  checkRole(config.team.limits.tempWorkers.role, 'ai', 'team.limits.tempWorkers.role');

  if (!config.team.members.some((m) => m.kind === 'human' && m.access === 'owner')) {
    issues.push({ code: 'no_owner', path: 'team.members' });
  }

  const repoNames = new Set<string>();
  config.project.repos.forEach((repo, i) => {
    if (repoNames.has(repo.name))
      issues.push({ code: 'duplicate_repo', path: `project.repos[${i}].name`, detail: repo.name });
    repoNames.add(repo.name);
  });

  const columns = new Set<string>();
  config.pipeline.columns.forEach((column, i) => {
    if (columns.has(column.id))
      issues.push({ code: 'duplicate_column', path: `pipeline.columns[${i}].id`, detail: column.id });
    columns.add(column.id);
  });
  const stageIds = new Set<string>();
  config.pipeline.stages.forEach((stage, i) => {
    const path = `pipeline.stages[${i}]`;
    if (stageIds.has(stage.id)) issues.push({ code: 'duplicate_stage', path, detail: stage.id });
    stageIds.add(stage.id);
    if (!columns.has(stage.columnId)) issues.push({ code: 'unknown_column', path, detail: stage.columnId });
    (stage.owners ?? []).forEach((h) => {
      if (!members.has(h)) issues.push({ code: 'unknown_member', path: `${path}.owners`, detail: h });
    });
    if (stage.duty && dutyMembers(config, stage.duty).length === 0)
      issues.push({ code: 'missing_duty_holder', path: `${path}.duty`, detail: stage.duty });
    let humanApproval = false;
    (stage.gate?.conditions ?? []).forEach((condition, j) => {
      const gatePath = `${path}.gate.conditions[${j}]`;
      const label = labelDefinition(config, condition.label);
      if (!label) {
        issues.push({ code: 'unknown_label', path: gatePath, detail: condition.label });
        return;
      }
      if (condition.type !== 'has_label' || label.setBy === 'system') return;
      const holders = labelHolders(config, label);
      if (holders.length === 0) {
        // Name the unfilled duties too: that is usually what the owner has to fix.
        if (typeof label.setBy === 'object')
          for (const duty of label.setBy.duties ?? [])
            if (dutyMembers(config, duty).length === 0)
              issues.push({ code: 'missing_duty_holder', path: gatePath, detail: duty });
        issues.push({ code: 'missing_label_setter', path: gatePath, detail: label.id });
      }
      if (!gateAcceptsCondition(stage, condition, label))
        issues.push({ code: 'release_approval_needs_duty', path: gatePath, detail: label.id });
      if (isHumanOnlyLabel(label) && holders.length > 0) humanApproval = true;
    });
    if (stage.kind === 'release' && !humanApproval) {
      issues.push({ code: 'release_without_human_approval', path });
    }
  });

  const labelIds = new Set<string>();
  config.pipeline.labels.forEach((label, i) => {
    const path = `pipeline.labels[${i}]`;
    if (labelIds.has(label.id)) issues.push({ code: 'duplicate_label', path, detail: label.id });
    labelIds.add(label.id);
    if (typeof label.setBy === 'object')
      (label.setBy.members ?? []).forEach((h) => {
        if (!members.has(h)) issues.push({ code: 'unknown_member', path: `${path}.setBy`, detail: h });
      });
  });

  const stages = config.pipeline.stages;
  if (stages[0] && stages[0].kind !== 'queue')
    issues.push({ code: 'first_stage_not_queue', path: 'pipeline.stages[0]' });
  const last = stages[stages.length - 1];
  if (last && last.kind !== 'done')
    issues.push({ code: 'last_stage_not_done', path: `pipeline.stages[${stages.length - 1}]` });

  for (const id of DUTY_IDS) {
    if (DUTIES[id].recommended && !dutyMembers(config, id).length)
      issues.push({ code: 'recommended_duty_unfilled', severity: 'warning', path: 'team', detail: id });
  }
  return issues;
}

const TOLERATED_ON_LOAD: ReadonlySet<ConfigIssue['code']> = new Set([
  'duplicate_repo',
  'duplicate_column',
  'release_approval_needs_duty',
]);

/**
 * Whether a configuration read back from storage may still carry this error. These are rules added
 * after configurations were written that no migration can repair without guessing: which of two
 * repositories or columns with the same name is meant, who should hold the release approval duty.
 * A stored configuration that breaks one still loads (the project stays usable and its owner can
 * repair it), and every change refuses it like any other error. Every other error stops a load.
 */
export function isToleratedOnLoad(issue: Pick<ConfigIssue, 'code'>): boolean {
  return TOLERATED_ON_LOAD.has(issue.code);
}

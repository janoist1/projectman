import type { GateCondition, LabelDefinition } from '@projectman/shared';
import { getLocale } from './locales';
import type { StandardLabelId, TemplateLocale } from './locales';

type LabelRules = Omit<LabelDefinition, 'id' | 'name' | 'meaning'>;

/** Rules of the labels templates ship; names and meanings come from the locale. */
export const STANDARD_LABEL_RULES: Record<StandardLabelId, LabelRules> = {
  'code-review-ok': {
    color: 'green',
    group: 'code-review',
    setBy: { duties: ['code_review'] },
    notByAuthor: true,
    clearedWhen: ['moved_back', 'pr_updated'],
  },
  'code-review-changes': {
    color: 'red',
    group: 'code-review',
    setBy: { duties: ['code_review'] },
    notByAuthor: true,
    requiresComment: true,
    notifyAssignee: true,
  },
  'code-review-blocked': {
    color: 'orange',
    group: 'code-review',
    setBy: { duties: ['code_review'] },
    notByAuthor: true,
    requiresComment: true,
    notifyAssignee: true,
  },
  'security-ok': {
    color: 'green',
    group: 'security',
    setBy: { duties: ['security_review'] },
    notByAuthor: true,
    clearedWhen: ['moved_back', 'pr_updated'],
  },
  'security-changes': {
    color: 'red',
    group: 'security',
    setBy: { duties: ['security_review'] },
    notByAuthor: true,
    requiresComment: true,
    notifyAssignee: true,
  },
  'qa-ok': {
    color: 'green',
    group: 'qa',
    setBy: { duties: ['testing_acceptance'] },
    notByAuthor: true,
    clearedWhen: ['moved_back'],
  },
  'qa-failed': {
    color: 'red',
    group: 'qa',
    setBy: { duties: ['testing_acceptance'] },
    notByAuthor: true,
    requiresComment: true,
    notifyAssignee: true,
  },
  'qa-retest': { color: 'yellow', group: 'qa', setBy: { duties: ['testing_acceptance'] }, notByAuthor: true },
  // The client decides; whoever talks to the client records the answer, the author included.
  'client-accepted': {
    color: 'green',
    group: 'client-test',
    setBy: { duties: ['client_communication', 'testing_acceptance'] },
    clearedWhen: ['moved_back'],
  },
  'client-changes': {
    color: 'red',
    group: 'client-test',
    setBy: { duties: ['client_communication', 'testing_acceptance'] },
    requiresComment: true,
    notifyAssignee: true,
  },
  'pr-merged': { color: 'purple', setBy: 'system' },
  'merge-approved': {
    color: 'teal',
    setBy: { duties: ['final_decision'], humansOnly: true },
    clearedWhen: ['moved_back', 'pr_updated'],
  },
  'release-approved': {
    color: 'orange',
    setBy: { duties: ['release_approval'], humansOnly: true },
    clearedWhen: ['moved_back', 'pr_updated'],
  },
  'waiting-answer': { color: 'yellow', setBy: 'anyone', blocks: true },
};

const STANDARD_IDS = Object.keys(STANDARD_LABEL_RULES) as StandardLabelId[];

export function isStandardLabel(id: string): id is StandardLabelId {
  return (STANDARD_IDS as string[]).includes(id);
}

export function standardLabel(id: StandardLabelId, locale: TemplateLocale): LabelDefinition {
  const words = locale.labels[id];
  return { id, name: words.name, meaning: words.meaning, ...STANDARD_LABEL_RULES[id] };
}

/** Definitions for the given standard labels, whole groups included, plus "waiting for an answer". */
export function standardLabelsFor(ids: Iterable<string>, locale: TemplateLocale): LabelDefinition[] {
  const wanted = new Set<StandardLabelId>(['waiting-answer']);
  for (const id of ids) {
    if (!isStandardLabel(id)) continue;
    const group = STANDARD_LABEL_RULES[id].group;
    for (const other of STANDARD_IDS)
      if (other === id || (group && STANDARD_LABEL_RULES[other].group === group)) wanted.add(other);
  }
  return STANDARD_IDS.filter((id) => wanted.has(id)).map((id) => standardLabel(id, locale));
}

export const hasLabel = (label: StandardLabelId | string): GateCondition => ({ type: 'has_label', label });
export const lacksLabel = (label: StandardLabelId | string): GateCondition => ({
  type: 'lacks_label',
  label,
});

/* ---------- configurations and tasks from before labels ---------- */

type LegacyCheck = 'code_review' | 'security_review' | 'qa' | 'client_test';
type LegacyCheckState = 'pending' | 'passed' | 'blocked' | 'failed' | 'retest_needed';

const LEGACY_CHECK_LABELS: Record<LegacyCheck, Partial<Record<LegacyCheckState, StandardLabelId>>> = {
  code_review: {
    passed: 'code-review-ok',
    failed: 'code-review-changes',
    retest_needed: 'code-review-changes',
    blocked: 'code-review-blocked',
  },
  security_review: {
    passed: 'security-ok',
    failed: 'security-changes',
    retest_needed: 'security-changes',
    blocked: 'security-changes',
  },
  qa: { passed: 'qa-ok', failed: 'qa-failed', blocked: 'qa-failed', retest_needed: 'qa-retest' },
  client_test: {
    passed: 'client-accepted',
    failed: 'client-changes',
    blocked: 'client-changes',
    retest_needed: 'client-changes',
  },
};

/** Labels standing for a task's recorded checks from before labels (pending ones have none). */
export function legacyCheckLabels(checks: Record<string, string | undefined> | null | undefined): string[] {
  const labels: string[] = [];
  for (const [check, state] of Object.entries(checks ?? {})) {
    const label = LEGACY_CHECK_LABELS[check as LegacyCheck]?.[state as LegacyCheckState];
    if (label) labels.push(label);
  }
  return labels;
}

interface LegacyStage {
  id: string;
  name: string;
  kind: string;
  gate?: { conditions: Array<Record<string, unknown>> };
}
interface LegacyConfig {
  project?: { language?: string };
  pipeline?: { stages?: LegacyStage[]; labels?: LabelDefinition[] };
}

/**
 * Rewrites a raw configuration from before labels: check_passed, pr_merged and human_approval
 * gate conditions become label conditions, and the labels they need are defined (standard ones
 * with their whole group; a stage-specific approval label for explicit approvers or other
 * duties). A configuration without legacy conditions is returned unchanged.
 */
export function migrateLegacyConfig<T>(raw: T): T {
  const config = raw as LegacyConfig;
  const stages = config?.pipeline?.stages;
  if (!Array.isArray(stages)) return raw;
  const legacy = (c: Record<string, unknown>) =>
    c.type === 'check_passed' || c.type === 'pr_merged' || c.type === 'human_approval';
  if (!stages.some((stage) => stage.gate?.conditions?.some(legacy))) return raw;

  const locale = getLocale(config.project?.language ?? 'en');
  const standard = new Set<string>();
  const custom: LabelDefinition[] = [];
  const nextStages = stages.map((stage) => {
    if (!stage.gate?.conditions?.some(legacy)) return stage;
    const conditions = stage.gate.conditions.map((c) => {
      if (c.type === 'check_passed') {
        const label = LEGACY_CHECK_LABELS[c.check as LegacyCheck]?.passed ?? String(c.check);
        standard.add(label);
        return { type: 'has_label', label };
      }
      if (c.type === 'pr_merged') {
        standard.add('pr-merged');
        return { type: 'has_label', label: 'pr-merged' };
      }
      if (c.type !== 'human_approval') return c;
      const approvers = c.approvers as string[] | undefined;
      const duty = c.duty as string | undefined;
      const standardApproval =
        !approvers && duty === 'release_approval'
          ? 'release-approved'
          : !approvers && duty === 'final_decision'
            ? 'merge-approved'
            : undefined;
      if (standardApproval) {
        standard.add(standardApproval);
        return { type: 'has_label', label: standardApproval };
      }
      const id = `approval-${stage.id.replace(/_/g, '-')}`.slice(0, 40);
      custom.push({
        id,
        name: locale.stageApproval(stage.name),
        color: 'orange',
        setBy: approvers
          ? { members: approvers, humansOnly: true }
          : { duties: [duty as never], humansOnly: true },
        clearedWhen: ['moved_back', 'pr_updated'],
      });
      return { type: 'has_label', label: id };
    });
    return { ...stage, gate: { conditions } };
  });
  const existing = new Set((config.pipeline?.labels ?? []).map((label) => label.id));
  const added = [...standardLabelsFor(standard, locale), ...custom].filter(
    (label) => !existing.has(label.id),
  );
  return {
    ...config,
    pipeline: {
      ...config.pipeline,
      stages: nextStages,
      labels: [...(config.pipeline?.labels ?? []), ...added],
    },
  } as T;
}

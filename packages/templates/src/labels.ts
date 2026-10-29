import {
  ACCEPTANCE_OPEN_LABEL,
  ACCEPTANCE_UNCONFIRMED_LABEL,
  DEFAULT_PROJECT_LANGUAGE,
  PR_MERGED_LABEL,
  REFINE_LABEL,
  type GateCondition,
  type LabelDefinition,
} from '@projectman/shared';
import { getLocale } from './locales';
import type { StandardLabelId, TemplateLocale } from './locales';

type LabelRules = Omit<LabelDefinition, 'id' | 'name' | 'meaning'>;

/** Rules of the labels templates ship; names and meanings come from the locale. */
const STANDARD_LABEL_RULES: Record<StandardLabelId, LabelRules> = {
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
  [PR_MERGED_LABEL]: { color: 'purple', setBy: 'system' },
  // Kept by the system from the card's acceptance items (PM-1135); the gates read them.
  [ACCEPTANCE_OPEN_LABEL]: { color: 'yellow', setBy: 'system' },
  [ACCEPTANCE_UNCONFIRMED_LABEL]: { color: 'orange', setBy: 'system' },
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
  // Sends the card to be worked out before development; the system takes it off when that is done.
  [REFINE_LABEL]: { color: 'blue', setBy: { duties: ['prioritization', 'task_breakdown'] } },
};

const STANDARD_IDS = Object.keys(STANDARD_LABEL_RULES) as StandardLabelId[];

function isStandardLabel(id: string): id is StandardLabelId {
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

/** A gate condition templates use: the label must be on the task. */
export const hasLabel = (label: StandardLabelId): GateCondition => ({ type: 'has_label', label });

/* ---------- acceptance items (PM-1135) ---------- */

interface GatedStage {
  id: string;
  kind: string;
  gate?: { conditions: Array<Record<string, unknown>> };
}

/**
 * The stages with the acceptance gates: no open acceptance item may come out of the work stage (the first
 * stage after it), and none may be unconfirmed at the end (the done stage). A pipeline without a work stage,
 * or with nothing after it, keeps its stages. A gate that has the condition already is left as it is.
 */
export function withAcceptanceGates<S extends GatedStage>(stages: readonly S[]): S[] {
  const work = stages.findIndex((stage) => stage.kind === 'work');
  const gateOf = new Map<string, string>();
  if (work >= 0 && work + 1 < stages.length) gateOf.set(stages[work + 1]!.id, ACCEPTANCE_OPEN_LABEL);
  const done = stages.findIndex((stage, index) => index > work && work >= 0 && stage.kind === 'done');
  const extra = (id: string): string[] => [
    ...(gateOf.get(id) ? [gateOf.get(id)!] : []),
    ...(done >= 0 && stages[done]!.id === id ? [ACCEPTANCE_UNCONFIRMED_LABEL] : []),
  ];
  return stages.map((stage) => {
    const missing = extra(stage.id).filter(
      (label) => !stage.gate?.conditions.some((c) => c.type === 'lacks_label' && c.label === label),
    );
    if (missing.length === 0) return stage;
    const conditions = [
      ...(stage.gate?.conditions ?? []),
      ...missing.map((label): GateCondition => ({ type: 'lacks_label', label })),
    ];
    return { ...stage, gate: { conditions } };
  });
}

/**
 * Gives an existing raw configuration the acceptance gates and the two system labels (idempotent): it
 * does nothing once the project defines `acceptance-open`, so a gate the owner removed later stays removed.
 */
export function migrateAcceptanceGates<T>(raw: T): T {
  const config = raw as LegacyConfig;
  const stages = config?.pipeline?.stages;
  if (!Array.isArray(stages)) return raw;
  const labels = config.pipeline?.labels ?? [];
  // What it cannot read is left to the schema.
  if (!Array.isArray(labels) || labels.some((label) => typeof label?.id !== 'string')) return raw;
  if (stages.some((stage) => typeof stage?.id !== 'string' || typeof stage.kind !== 'string')) return raw;
  if (stages.some((stage) => stage.gate !== undefined && !Array.isArray(stage.gate?.conditions))) return raw;
  if (labels.some((label) => label.id === ACCEPTANCE_OPEN_LABEL)) return raw;
  const gated = withAcceptanceGates(stages);
  if (gated.every((stage, index) => stage === stages[index])) return raw;
  const locale = getLocale(config.project?.language ?? DEFAULT_PROJECT_LANGUAGE);
  return {
    ...config,
    pipeline: {
      ...config.pipeline,
      stages: gated,
      labels: [
        ...labels,
        ...[ACCEPTANCE_OPEN_LABEL, ACCEPTANCE_UNCONFIRMED_LABEL]
          .filter((id): id is StandardLabelId => !labels.some((label) => label.id === id))
          .map((id) => standardLabel(id, locale)),
      ],
    },
  } as T;
}

/* ---------- configurations from before labels ---------- */

type LegacyCheck = 'code_review' | 'security_review' | 'qa' | 'client_test';
const LEGACY_PASSED_CHECK_LABELS: Record<LegacyCheck, StandardLabelId> = {
  code_review: 'code-review-ok',
  security_review: 'security-ok',
  qa: 'qa-ok',
  client_test: 'client-accepted',
};

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

  // Name the labels in the language the configuration loads with (the schema's default when unset).
  const locale = getLocale(config.project?.language ?? DEFAULT_PROJECT_LANGUAGE);
  const standard = new Set<string>();
  const custom: LabelDefinition[] = [];
  const nextStages = stages.map((stage) => {
    if (!stage.gate?.conditions?.some(legacy)) return stage;
    const conditions = stage.gate.conditions.map((c) => {
      if (c.type === 'check_passed') {
        const label = LEGACY_PASSED_CHECK_LABELS[c.check as LegacyCheck] ?? String(c.check);
        standard.add(label);
        return { type: 'has_label', label };
      }
      if (c.type === 'pr_merged') {
        standard.add(PR_MERGED_LABEL);
        return { type: 'has_label', label: PR_MERGED_LABEL };
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

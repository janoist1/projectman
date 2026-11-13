import {
  ACCEPTANCE_OPEN_LABEL,
  ACCEPTANCE_UNCONFIRMED_LABEL,
  PR_MERGED_LABEL,
  REFINE_LABEL,
  type GateCondition,
  type LabelDefinition,
} from '@projectman/shared';
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
 * stage after it), and none may be unconfirmed when the work is merged (the merge target: the first release
 * stage, else the done stage, so the merge readiness reads that gate) or at the end (the done stage). A
 * pipeline without a work stage, or with nothing after it, keeps its stages. A gate that has the condition
 * already is left as it is.
 */
export function withAcceptanceGates<S extends GatedStage>(stages: readonly S[]): S[] {
  const work = stages.findIndex((stage) => stage.kind === 'work');
  const gateOf = new Map<string, string>();
  if (work >= 0 && work + 1 < stages.length) gateOf.set(stages[work + 1]!.id, ACCEPTANCE_OPEN_LABEL);
  const after = (kind: string) =>
    stages.findIndex((stage, index) => index > work && work >= 0 && stage.kind === kind);
  const unconfirmed = new Set(
    [after('release'), after('done')].filter((index) => index >= 0).map((index) => stages[index]!.id),
  );
  const extra = (id: string): string[] => [
    ...(gateOf.get(id) ? [gateOf.get(id)!] : []),
    ...(unconfirmed.has(id) ? [ACCEPTANCE_UNCONFIRMED_LABEL] : []),
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

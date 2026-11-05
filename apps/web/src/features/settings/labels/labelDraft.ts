import { isHumanOnlyLabel } from '@projectman/shared';
import type {
  DutyId,
  LabelClearTrigger,
  LabelColor,
  LabelDefinition,
  LabelSetBy,
  ProjectConfig,
} from '@projectman/shared';
import { labelId } from '../../../lib/ids';

/** Who may set a label, as the panel offers it: the two lists of `LabelSetBy` are two modes of one choice. */
export type SetterMode = 'anyone' | 'humans' | 'system' | 'duties' | 'members';

/** What the panel edits: one label, with the choices of the mode that is not active kept while the draft is open. */
export interface LabelDraft {
  /** The saved label's id; empty for a label that is not created yet. */
  id: string;
  name: string;
  color: LabelColor | '';
  meaning: string;
  group: string;
  mode: SetterMode;
  duties: DutyId[];
  members: string[];
  humansOnly: boolean;
  /** The saved label named duties and members together: both lists stay in force, whichever mode is shown. */
  mixed: boolean;
  notByAuthor: boolean;
  requiresComment: boolean;
  notifyAssignee: boolean;
  blocks: boolean;
  clearedWhen: LabelClearTrigger[];
}

export const BLANK_LABEL: LabelDraft = {
  id: '',
  name: '',
  color: '',
  meaning: '',
  group: '',
  mode: 'anyone',
  duties: [],
  members: [],
  humansOnly: false,
  mixed: false,
  notByAuthor: false,
  requiresComment: false,
  notifyAssignee: false,
  blocks: false,
  clearedWhen: [],
};

export function draftOf(label: LabelDefinition): LabelDraft {
  const { setBy } = label;
  const object = typeof setBy === 'object' ? setBy : null;
  const duties = object?.duties ?? [];
  const members = object?.members ?? [];
  return {
    id: label.id,
    name: label.name,
    color: label.color ?? '',
    meaning: label.meaning ?? '',
    group: label.group ?? '',
    mode: object ? (duties.length > 0 ? 'duties' : 'members') : (setBy as SetterMode),
    duties: [...duties],
    members: [...members],
    humansOnly: object?.humansOnly === true,
    mixed: duties.length > 0 && members.length > 0,
    notByAuthor: label.notByAuthor === true,
    requiresComment: label.requiresComment === true,
    notifyAssignee: label.notifyAssignee === true,
    blocks: label.blocks === true,
    clearedWhen: [...(label.clearedWhen ?? [])],
  };
}

function setByOf(draft: LabelDraft): LabelSetBy {
  if (draft.mode !== 'duties' && draft.mode !== 'members') return draft.mode;
  // Only the chosen way is saved, unless the label held both lists to begin with.
  const useDuties = draft.mode === 'duties' || draft.mixed;
  const useMembers = draft.mode === 'members' || draft.mixed;
  return {
    ...(useDuties && draft.duties.length > 0 ? { duties: draft.duties } : {}),
    ...(useMembers && draft.members.length > 0 ? { members: draft.members } : {}),
    ...(draft.humansOnly ? { humansOnly: true } : {}),
  } as LabelSetBy;
}

/**
 * The label a draft stands for. A group written as it was saved stays as it was; a new or changed one is made
 * an id the way the card's labels are.
 */
export function labelOf(draft: LabelDraft, id: string, saved?: LabelDefinition): LabelDefinition {
  const label: LabelDefinition = { id, name: draft.name.trim(), setBy: setByOf(draft) };
  if (draft.color) label.color = draft.color;
  if (draft.meaning.trim()) label.meaning = draft.meaning;
  const group = draft.group.trim();
  if (group) label.group = group === saved?.group ? group : labelId(group, []);
  if (draft.notByAuthor) label.notByAuthor = true;
  if (draft.requiresComment) label.requiresComment = true;
  if (draft.notifyAssignee) label.notifyAssignee = true;
  if (draft.clearedWhen.length > 0) label.clearedWhen = draft.clearedWhen;
  if (draft.blocks) label.blocks = true;
  return label;
}

/** The configuration with the saved label `id` replaced by the draft's. */
export function withLabel(config: ProjectConfig, draft: LabelDraft, id: string): ProjectConfig {
  const labels = config.pipeline.labels;
  const saved = labels.find((label) => label.id === id);
  const next = labelOf(draft, id, saved);
  return {
    ...config,
    pipeline: { ...config.pipeline, labels: labels.map((label) => (label === saved ? next : label)) },
  };
}

/**
 * The configuration with the draft added as a new label. It is only appended: an id someone took meanwhile is a
 * duplicate for the shared rules to refuse, never a label to overwrite.
 */
export function withNewLabel(config: ProjectConfig, draft: LabelDraft, id: string): ProjectConfig {
  return {
    ...config,
    pipeline: { ...config.pipeline, labels: [...config.pipeline.labels, labelOf(draft, id)] },
  };
}

export function withoutLabel(config: ProjectConfig, id: string): ProjectConfig {
  return {
    ...config,
    pipeline: { ...config.pipeline, labels: config.pipeline.labels.filter((label) => label.id !== id) },
  };
}

/** A new label's id from its name, unique among the saved ones. */
export function newLabelId(config: ProjectConfig, name: string): string {
  return labelId(
    name,
    config.pipeline.labels.map((label) => label.id),
  );
}

type GateUse = 'requires' | 'forbids' | 'when';

export interface LabelUsage {
  stageId: string;
  stageName: string;
  use: GateUse;
}

/** The gate conditions that ask for the label, forbid it or bind to it (`when`), one entry each. */
export function labelUsage(config: ProjectConfig, id: string): LabelUsage[] {
  const uses: LabelUsage[] = [];
  for (const stage of config.pipeline.stages)
    for (const condition of stage.gate?.conditions ?? []) {
      const base = { stageId: stage.id, stageName: stage.name };
      if (condition.label === id)
        uses.push({ ...base, use: condition.type === 'has_label' ? 'requires' : 'forbids' });
      if (condition.when === id) uses.push({ ...base, use: 'when' });
    }
  return uses;
}

/** An approval is the owner's to change: someone who is not an owner cannot change what only an owner may set. */
export function isOwnerLocked(label: LabelDefinition | undefined, isOwner: boolean): boolean {
  return label !== undefined && isHumanOnlyLabel(label) && !isOwner;
}

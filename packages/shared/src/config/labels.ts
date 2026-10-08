import type { Actor } from '../domain/event';
import { isHumanOnlyLabel, RELEASE_APPROVAL_DUTY } from '../domain/label';
import type { LabelClearTrigger, LabelDefinition, LabelRefusal } from '../domain/label';
import type { Stage } from '../domain/pipeline';
import type { Task } from '../domain/task';
import { dutyMembers, REVIEW_DUTIES, taskAuthors } from './duties';
import type { ProjectConfig } from './schema';

type LabelConfig = Pick<ProjectConfig, 'team' | 'pipeline'>;

/** Approvals delegated keys cannot give, including conditional gate requirements. */
export function isOwnerApprovalLabel(config: LabelConfig, label: LabelDefinition): boolean {
  return (
    isHumanOnlyLabel(label) ||
    label.notByAuthor === true ||
    config.pipeline.stages.some((stage) =>
      stage.gate?.conditions.some(
        (condition) => condition.type === 'has_label' && condition.label === label.id,
      ),
    )
  );
}

/**
 * Whether a review or test already gave the work back (PM-183): the task carries a result label of
 * a reviewing or testing duty that needs a note, such as "changes needed", "failed" or "blocked",
 * and not an approval. The developer's next commits are then the expected fixes, not a branch that
 * moved behind the reviewer's back.
 */
export function reviewReturnedWork(
  config: Pick<ProjectConfig, 'pipeline'>,
  task: Pick<Task, 'labels'>,
): boolean {
  return task.labels.some((id) => {
    const label = labelDefinition(config, id);
    const setBy = label?.setBy;
    return (
      label?.requiresComment === true &&
      typeof setBy === 'object' &&
      (setBy.duties ?? []).some((duty) => REVIEW_DUTIES.includes(duty))
    );
  });
}

export function labelDefinition(
  config: Pick<ProjectConfig, 'pipeline'>,
  id: string,
): LabelDefinition | undefined {
  return config.pipeline.labels.find((label) => label.id === id);
}

/** Label ids required by the gates of release stages (four eyes applies to them). */
export function releaseGateLabels(config: Pick<ProjectConfig, 'pipeline'>): Set<string> {
  return new Set(
    config.pipeline.stages
      .filter((stage) => stage.kind === 'release')
      .flatMap((stage) => stage.gate?.conditions ?? [])
      .filter((condition) => condition.type === 'has_label')
      .map((condition) => condition.label),
  );
}

/** The humans who may give the approval of a release: the holders of the release approval duty. */
export function releaseApprovers(config: Pick<ProjectConfig, 'team'>): string[] {
  return dutyMembers(config, RELEASE_APPROVAL_DUTY)
    .filter((member) => member.kind === 'human')
    .map((member) => member.handle);
}

/** Members who may set a label, before the self-review rule (system labels: nobody). */
export function labelHolders(config: Pick<ProjectConfig, 'team'>, label: LabelDefinition): string[] {
  const setBy = label.setBy;
  if (setBy === 'system') return [];
  if (setBy === 'anyone') return config.team.members.map((m) => m.handle);
  if (setBy === 'humans') return config.team.members.filter((m) => m.kind === 'human').map((m) => m.handle);
  const handles = new Set(setBy.members ?? []);
  for (const duty of setBy.duties ?? [])
    for (const member of dutyMembers(config, duty)) handles.add(member.handle);
  return config.team.members
    .filter((m) => handles.has(m.handle) && (!setBy.humansOnly || m.kind === 'human'))
    .map((m) => m.handle);
}

/** A label excludes the task's authors: its own rule, or four eyes on a release approval. */
export function labelExcludesAuthors(config: LabelConfig, label: LabelDefinition): boolean {
  return (
    label.notByAuthor === true ||
    (config.team.releaseFourEyes === true && releaseGateLabels(config).has(label.id))
  );
}

/** Members who may set a label on this task: holders minus authors where self-review is excluded. */
export function labelSetters(
  config: LabelConfig,
  label: LabelDefinition,
  task: Pick<Task, 'assignee' | 'links'>,
) {
  const authors = labelExcludesAuthors(config, label) ? taskAuthors(task) : [];
  return labelHolders(config, label).filter((handle) => !authors.includes(handle));
}

/**
 * Why an actor may not add or remove a label on a task, or null when it may. The system actor
 * (integrations, automatic clearing) may change any label; plain tags (no definition) are open.
 */
export function labelRefusal(
  config: LabelConfig,
  label: LabelDefinition | undefined,
  actor: Actor,
  task: Pick<Task, 'assignee' | 'links'>,
): LabelRefusal | null {
  if (actor.kind === 'system' || !label) return null;
  if (actor.via === 'integrator' && isOwnerApprovalLabel(config, label)) return 'owner_approval';
  if (label.setBy === 'system') return 'system_only';
  if (isHumanOnlyLabel(label) && actor.kind !== 'human') return 'humans_only';
  if (!labelHolders(config, label).includes(actor.handle ?? '')) return 'not_holder';
  if (labelExcludesAuthors(config, label) && taskAuthors(task).includes(actor.handle ?? ''))
    return 'self_review';
  return null;
}

/**
 * Labels a stage's gate requires, split into approvals (human-only) and other facts. Conditions
 * that bind only the tasks carrying a `when` label are listed apart in `conditional`: they do not
 * hold for every task, so a hand-over cannot count on them.
 */
export function gateLabels(config: Pick<ProjectConfig, 'pipeline'>, stage: Stage) {
  const conditions = stage.gate?.conditions ?? [];
  const always = conditions.filter((c) => c.when === undefined);
  const required = always.filter((c) => c.type === 'has_label').map((c) => c.label);
  return {
    conditional: conditions.flatMap((c) =>
      c.when === undefined ? [] : [{ type: c.type, label: c.label, when: c.when }],
    ),
    approvals: required.filter((id) => {
      const label = labelDefinition(config, id);
      return label !== undefined && isHumanOnlyLabel(label);
    }),
    facts: required.filter((id) => {
      const label = labelDefinition(config, id);
      return label === undefined || !isHumanOnlyLabel(label);
    }),
    forbidden: always.filter((c) => c.type === 'lacks_label').map((c) => c.label),
  };
}

/**
 * A label change refused as a whole (REST and team tools answer with `code`): the first label
 * the actor may not change, or the added labels that need a comment when none was given.
 */
export type LabelChangeRefusal =
  | { code: 'owner_approval_required'; label: string }
  | { code: 'self_review_forbidden'; label: string }
  | { code: 'label_not_allowed'; label: string; reason: LabelRefusal }
  | { code: 'comment_required'; labels: string[] };

/** The outcome of a requested label change, or why it is refused. */
export type LabelChangePlan =
  | {
      ok: true;
      /** The task's labels after the change. */
      labels: string[];
      added: string[];
      /** Removed on request, plus the labels of a group an added label replaces. */
      removed: string[];
      /** Added labels that notify the task's assignee. */
      notify: string[];
    }
  | { ok: false; refusal: LabelChangeRefusal };

/**
 * Plans adding and removing labels under the project's label rules: who may set them, no
 * self-review, a comment when a label asks for one. Labels already on the task are not added
 * again, missing ones are not removed, and adding a grouped label replaces the other labels of
 * its group. Any refused label refuses the whole change.
 */
export function planLabelChange(
  config: LabelConfig,
  task: Pick<Task, 'labels' | 'assignee' | 'links'>,
  change: { add?: readonly string[]; remove?: readonly string[] },
  actor: Actor,
  comment?: string,
): LabelChangePlan {
  const add = [...new Set((change.add ?? []).map((label) => label.trim()).filter(Boolean))].filter(
    (label) => !task.labels.includes(label),
  );
  const remove = [...new Set(change.remove ?? [])].filter(
    (label) => task.labels.includes(label) && !add.includes(label),
  );
  for (const label of [...add, ...remove]) {
    const refusal = labelRefusal(
      config,
      labelDefinition(config, label),
      remove.includes(label) && actor.via ? { kind: actor.kind, handle: actor.handle } : actor,
      task,
    );
    if (refusal === 'owner_approval')
      return { ok: false, refusal: { code: 'owner_approval_required', label } };
    if (refusal === 'self_review') return { ok: false, refusal: { code: 'self_review_forbidden', label } };
    if (refusal) return { ok: false, refusal: { code: 'label_not_allowed', label, reason: refusal } };
  }
  const needsComment = add.filter((label) => labelDefinition(config, label)?.requiresComment);
  if (needsComment.length > 0 && !comment?.trim())
    return { ok: false, refusal: { code: 'comment_required', labels: needsComment } };
  const groups = new Set(add.map((label) => labelDefinition(config, label)?.group).filter(Boolean));
  const replaced = task.labels.filter(
    (label) => !add.includes(label) && groups.has(labelDefinition(config, label)?.group),
  );
  const removed = [...new Set([...remove, ...replaced])];
  return {
    ok: true,
    labels: [...task.labels.filter((label) => !removed.includes(label)), ...add],
    added: add,
    removed,
    notify: add.filter((label) => labelDefinition(config, label)?.notifyAssignee),
  };
}

/** Labels on the task that come off on an event (the task moving back, its pull request changing). */
export function expiredLabels(
  config: Pick<ProjectConfig, 'pipeline'>,
  task: Pick<Task, 'labels'>,
  trigger: LabelClearTrigger,
): string[] {
  return task.labels.filter((label) => labelDefinition(config, label)?.clearedWhen?.includes(trigger));
}

/**
 * Why a human may not approve a gate request (approving puts its label on the task), or null:
 * they do not hold the label (`not_an_assignee`), or they authored the task while the label
 * excludes its authors (four eyes on a release approval, or the label's own rule).
 */
export function approvalRefusal(
  config: LabelConfig,
  labelId: string,
  approver: string,
  task: Pick<Task, 'assignee' | 'links'> | null,
): 'not_an_assignee' | 'release_four_eyes' | 'self_review_forbidden' | null {
  const label = labelDefinition(config, labelId);
  if (!label) return null;
  const refusal = labelRefusal(
    config,
    label,
    { kind: 'human', handle: approver },
    task ?? { assignee: null, links: [] },
  );
  if (refusal === 'self_review')
    return config.team.releaseFourEyes === true && releaseGateLabels(config).has(label.id)
      ? 'release_four_eyes'
      : 'self_review_forbidden';
  return refusal ? 'not_an_assignee' : null;
}

/**
 * Why nobody may approve a gate request for the label on this task, or null when someone may:
 * every holder authored the task (four eyes on a release approval, or the label's own rule), or
 * nobody holds the label.
 */
export function noApproverReason(
  config: LabelConfig,
  labelId: string,
  task: Pick<Task, 'assignee' | 'links'>,
): 'release_four_eyes' | 'self_review_forbidden' | 'missing_duty_holder' | null {
  const label = labelDefinition(config, labelId);
  if (!label || labelSetters(config, label, task).length > 0) return null;
  if (labelHolders(config, label).length === 0) return 'missing_duty_holder';
  return config.team.releaseFourEyes === true && releaseGateLabels(config).has(label.id)
    ? 'release_four_eyes'
    : 'self_review_forbidden';
}

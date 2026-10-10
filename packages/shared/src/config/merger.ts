import { hasAccess } from '../domain/member';
import type { Stage } from '../domain/pipeline';
import type { Task } from '../domain/task';
import { isCodeReviewStage, stageOwners } from './duties';
import { evaluateMove, stageIndex } from './gates';
import type { UnmetCondition, ApprovalRequirement } from './gates';
import { isHandleOnLeave } from './leave';
import { memberOf } from './lookup';
import { effectiveRepo, repoOf } from './repos';
import type { Merger, ProjectConfig, RepoConfig } from './schema';

/**
 * Who merges a card's approved work into the repository's default branch, and when (PM-448,
 * decisions 47 and 48). The system never merges by itself: a member does, and the project's setting
 * (`team.merger`) says which one. One rule for the server and the web.
 */

type MergerConfig = Pick<ProjectConfig, 'team' | 'pipeline'>;
type GateTask = Pick<Task, 'labels' | 'assignee' | 'links'>;

/** Absent: merge unless an integrating session merges (`fullTestAtMerge`, decision 40: PM until PM-386). */
export function requiresMerge(repo: Pick<RepoConfig, 'requireMerge' | 'fullTestAtMerge'>): boolean {
  return repo.requireMerge ?? repo.fullTestAtMerge !== true;
}

/** The stage a card enters with its work merged: the first release stage, else the done stage; null: none. */
export function mergeTargetOf(config: Pick<ProjectConfig, 'pipeline'>): Stage | null {
  const stages = config.pipeline.stages;
  return stages.find((s) => s.kind === 'release') ?? stages.find((s) => s.kind === 'done') ?? null;
}

/** The stages before the merge target (empty without a target). */
function stagesBeforeTarget(config: Pick<ProjectConfig, 'pipeline'>): Stage[] {
  const target = mergeTargetOf(config);
  return target ? config.pipeline.stages.slice(0, stageIndex(config.pipeline, target.id)) : [];
}

/** The code review stage nearest to the target, before it; undefined: none. */
function codeReviewStageBeforeTarget(config: MergerConfig): Stage | undefined {
  return stagesBeforeTarget(config)
    .reverse()
    .find((stage) => isCodeReviewStage(config, stage));
}

/** code_reviewer when a code review stage (isCodeReviewStage) comes before the target; else developer. */
export function defaultMerger(config: MergerConfig): Merger {
  return codeReviewStageBeforeTarget(config) ? { kind: 'code_reviewer' } : { kind: 'developer' };
}

/** team.merger ?? defaultMerger(config). */
export function mergerOf(config: MergerConfig): Merger {
  return config.team.merger ?? defaultMerger(config);
}

/**
 * Why the project's merger can never resolve, as the detail of the `merger_unresolved` issue (the kind,
 * or the handle of a `member`); null when it can, or when nothing is to be merged (no repository that
 * requires a merge, or no merge target).
 */
export function unresolvedMerger(config: ProjectConfig): string | null {
  if (!config.project.repos.some(requiresMerge) || !mergeTargetOf(config)) return null;
  const merger = mergerOf(config);
  if (merger.kind === 'code_reviewer') return codeReviewStageBeforeTarget(config) ? null : merger.kind;
  if (merger.kind === 'developer')
    return stagesBeforeTarget(config).some((s) => s.kind === 'work') ? null : merger.kind;
  const member = memberOf(config, merger.handle);
  return member && (member.kind === 'ai' || hasAccess(member.access, 'developer')) ? null : merger.handle;
}

/**
 * The repository a move must have merged into: a forward move from a stage before the target to the
 * target or beyond, of a card whose effective repository (effectiveRepo) requires a merge; else null.
 */
export function mergeRepoOf(
  config: ProjectConfig,
  task: Pick<Task, 'repo'>,
  fromStageId: string,
  toStageId: string,
): RepoConfig | null {
  const target = mergeTargetOf(config);
  if (!target) return null;
  const targetIndex = stageIndex(config.pipeline, target.id);
  const from = stageIndex(config.pipeline, fromStageId);
  const to = stageIndex(config.pipeline, toStageId);
  if (from < 0 || from >= targetIndex || to < targetIndex) return null;
  const repo = repoOf(config, effectiveRepo(config, task));
  return repo && requiresMerge(repo) ? repo : null;
}

/**
 * The member who merges this card; null: nobody can.
 * - code_reviewer: `codeReviewer` when they own the code review stage before the target (stageOwners),
 *   else that stage's first owner who is not on leave;
 * - developer: task.assignee;
 * - member: the handle, when it is a member of the team (a human needs `developer` access or more).
 * Leave is not skipped for developer and member: the card waits, and „Miért áll?” shows it.
 */
export function cardMerger(
  config: MergerConfig,
  task: Pick<Task, 'assignee'>,
  codeReviewer: string | null,
): string | null {
  const merger = mergerOf(config);
  if (merger.kind === 'developer') return task.assignee ?? null;
  if (merger.kind === 'member') {
    const member = memberOf(config, merger.handle);
    if (!member) return null;
    return member.kind === 'human' && !hasAccess(member.access, 'developer') ? null : member.handle;
  }
  const stage = codeReviewStageBeforeTarget(config);
  if (!stage) return null;
  const owners = stageOwners(config, stage);
  if (codeReviewer && owners.includes(codeReviewer) && !isHandleOnLeave(config, codeReviewer))
    return codeReviewer;
  return owners.find((handle) => memberOf(config, handle) && !isHandleOnLeave(config, handle)) ?? null;
}

export type MergeReadiness =
  | { ready: true; repo: RepoConfig; target: Stage }
  | { ready: false; reason: 'no_merge' | 'not_before_target' | 'gate' };

/**
 * Ready to merge: the card's repository requires a merge (`no_merge`), the card is in the stage right
 * before the target (`not_before_target`), and `evaluateMove` into the target has no unmet condition and
 * no missing approval (`gate`). For a release target its has_label conditions are left out: the release
 * approval comes after the merge (Webes ügyfélprojekt: Merge → Release).
 */
export function mergeReadiness(
  config: ProjectConfig,
  task: GateTask & Pick<Task, 'stageId' | 'repo'>,
): MergeReadiness {
  const target = mergeTargetOf(config);
  const repo = target ? repoOf(config, effectiveRepo(config, task)) : undefined;
  if (!target || !repo || !requiresMerge(repo)) return { ready: false, reason: 'no_merge' };
  const targetIndex = stageIndex(config.pipeline, target.id);
  if (targetIndex < 1 || stageIndex(config.pipeline, task.stageId) !== targetIndex - 1)
    return { ready: false, reason: 'not_before_target' };
  const evaluation = evaluateMove(task, config, task.stageId, target.id);
  const leftOut = (stageId: string) => target.kind === 'release' && stageId === target.id;
  const unmet = evaluation.unmet.filter(
    (u: UnmetCondition) => !(leftOut(u.stageId) && u.condition.type === 'has_label'),
  );
  const approvals = evaluation.approvals.filter((a: ApprovalRequirement) => !leftOut(a.stageId));
  return unmet.length === 0 && approvals.length === 0
    ? { ready: true, repo, target }
    : { ready: false, reason: 'gate' };
}

import type { MergeBlockReason, ProjectConfig, Task, TaskMergeState } from '@projectman/shared';
import { cardMerger, effectiveRepo, mergeTargetOf } from '@projectman/shared';
import { isApiError } from '../api/client';
import { t, tDynamic } from '../i18n/t';
import type { MessageKey } from '../i18n/t';
import { nameOf } from './members';
import type { MemberIndex } from './members';

/**
 * The merge into the main branch as the screens tell it (PM-453). The rules (who merges, when a move
 * needs the work merged) live in `@projectman/shared`; this is the wording and the small questions the
 * views share: is the viewer the merger, what step runs, why it stopped.
 */

type RepoFacts = Partial<Pick<ProjectConfig, 'project'>> | undefined;

/** The configuration as the board model carries it: the team and the pipeline, the repositories when known. */
export type MergeConfig = Pick<ProjectConfig, 'team' | 'pipeline'> & Partial<Pick<ProjectConfig, 'project'>>;

/** The repository the merge is about, as the configuration describes it (undefined while it is not known). */
export function mergeRepo(
  config: RepoFacts,
  repo: string,
): ProjectConfig['project']['repos'][number] | undefined {
  return config?.project?.repos.find((entry) => entry.name === repo);
}

/** True when the repository's remote is GitHub; an unknown configuration reads as GitHub. */
export function mergeOnGithub(config: RepoFacts, repo: string): boolean {
  const entry = mergeRepo(config, repo);
  return entry ? !!entry.github : true;
}

/** The check the merge runs: the repository's review test, else what the merge itself recorded. */
export function mergeCheckCommand(config: RepoFacts, merge: TaskMergeState): string | null {
  return merge.check?.command ?? mergeRepo(config, merge.repo)?.reviewTest?.command ?? null;
}

/** The viewer is the member asked to merge the card. */
export function isMerger(
  merge: Pick<TaskMergeState, 'merger'> | undefined,
  myHandle: string | null,
): boolean {
  return !!merge && !!myHandle && merge.merger === myHandle;
}

/** The commit the merge is about: the one the merge recorded, else the one handed over for review. */
export function mergeCommitOf(task: Pick<Task, 'merge' | 'reviewPin'>): string | null {
  return task.merge?.commit ?? task.reviewPin?.commit ?? null;
}

/** The name of the step a running merge is in ("összefésülés", "ellenőrzés fut", "felküldés"). */
export function mergeStepText(step: TaskMergeState['step']): string {
  return t(`taskStatus.merge.steps.${step ?? 'queued'}`);
}

/** The name of the stage the merge lets the card enter. */
export function mergeTargetName(
  config: Pick<ProjectConfig, 'pipeline'> | undefined,
  merge: Pick<TaskMergeState, 'toStageId'>,
): string {
  return config?.pipeline.stages.find((stage) => stage.id === merge.toStageId)?.name ?? merge.toStageId;
}

/** The name of the stage a merge-requiring move enters, with no merge open yet. */
export function defaultTargetName(config: Pick<ProjectConfig, 'pipeline'> | undefined): string {
  return (config && mergeTargetOf(config)?.name) ?? '';
}

/** Why the merge stopped, in one sentence: the shared reasons, in the wording of the repository's remote. */
export function mergeBlockText(
  merge: Pick<TaskMergeState, 'repo' | 'base' | 'landed' | 'block' | 'check' | 'toStageId'>,
  facts: { github: boolean; check: string | null; target: string },
): string {
  const block = merge.block;
  if (!block) return '';
  const reason: MergeBlockReason = block.reason;
  const key = reason === 'local_checkout' && merge.landed === 'remote' ? 'local_checkout_remote' : reason;
  const params = {
    repo: merge.repo,
    base: merge.base,
    check: facts.check ?? merge.check?.command ?? '',
    target: facts.target,
  };
  const fallback = t('task.merge.blocked.reasons.merge_error');
  if (!facts.github) {
    const remote = tDynamic(`task.merge.blocked.reasonsRemote.${key}`, '', params);
    if (remote) return remote;
  }
  return tDynamic(`task.merge.blocked.reasons.${key}`, fallback, params);
}

/** Where the merge condition of a move stands, from the card's own fields only (the server has the last word). */
export type MergeConditionState = 'met' | 'waiting' | 'running' | 'failed' | 'blocked' | 'none';

export function mergeConditionState(task: Pick<Task, 'merge' | 'merged'>): MergeConditionState {
  const merge = task.merge;
  if (merge) {
    if (merge.state === 'queued' || merge.state === 'running') return 'running';
    return merge.state === 'requested' ? 'waiting' : merge.state;
  }
  return task.merged ? 'met' : 'none';
}

export const mergeConditionKey = {
  met: 'task.move.merge.met',
  waiting: 'task.move.merge.waiting',
  running: 'task.move.merge.running',
  failed: 'task.move.merge.failed',
  blocked: 'task.move.merge.blocked',
  none: 'task.move.merge.none',
} as const satisfies Record<MergeConditionState, MessageKey>;

/** "A 3fa81c2a commit" / "A jóváhagyott munka": the work the merge is about; `lower` starts it with "a". */
export function mergeWhat(shortCommit: string | null, lower = false): string {
  if (lower)
    return shortCommit
      ? t('task.merge.whatLower', { commit: shortCommit })
      : t('task.merge.whatLowerUnknown');
  return shortCommit ? t('task.merge.what', { commit: shortCommit }) : t('task.merge.whatUnknown');
}

/** What merging does, for the one who merges: the commit goes into the branch, the check runs, the push follows. */
export function mergeRequestedText(input: {
  commit: string | null;
  base: string;
  check: string | null;
  /** The repository has a remote the merge pushes to. */
  push: boolean;
}): string {
  const { commit, base, check, push } = input;
  const params = { what: mergeWhat(commit), base, check: check ?? '' };
  return check
    ? t(push ? 'task.merge.requested.pushCheck' : 'task.merge.requested.check', params)
    : t(push ? 'task.merge.requested.push' : 'task.merge.requested.plain', params);
}

/** Why a move into a step that wants the work merged is refused (`task_not_merged`, PM-452). */
export type NotMergedReason = 'not_merged' | 'not_on_remote' | 'engine_unavailable';

export interface NotMerged {
  reason: NotMergedReason;
  merger: string | null;
  base: string;
}

/** The details of a `task_not_merged` refusal; null for any other error. */
export function notMergedOf(error: unknown): NotMerged | null {
  if (!isApiError(error) || error.code !== 'task_not_merged') return null;
  const details = (error.details ?? {}) as { reason?: unknown; merger?: unknown; base?: unknown };
  const reason: NotMergedReason =
    details.reason === 'not_on_remote' || details.reason === 'engine_unavailable'
      ? details.reason
      : 'not_merged';
  return {
    reason,
    merger: typeof details.merger === 'string' ? details.merger : null,
    base: typeof details.base === 'string' ? details.base : '',
  };
}

export interface RefusalFacts {
  members: MemberIndex;
  myHandle: string | null;
  /** The abbreviated commit the merge is about, when the card says it. */
  commit?: string | null;
  /** The repository's remote is GitHub (also when the configuration is not known). */
  github?: boolean;
  /** The name of the stage the move would enter. */
  target: string;
}

export interface MergeRefusal {
  /** `info`: nothing for the viewer to do but wait; `error`: something to do, or something wrong. */
  tone: 'info' | 'error';
  text: string;
  /** The viewer is the merger and can act on it: the refusal offers the Beolvasztás button. */
  mayMerge: boolean;
}

/** The facts a refusal needs, from the card and the configuration (an unknown configuration reads as GitHub). */
export function refusalFactsOf(input: {
  task: Pick<Task, 'merge' | 'reviewPin' | 'repo'> | undefined;
  config: MergeConfig | undefined;
  members: MemberIndex;
  myHandle: string | null;
  target: string;
}): RefusalFacts {
  const { task, config, members, myHandle, target } = input;
  const commit = task ? mergeCommitOf(task) : null;
  return {
    members,
    myHandle,
    commit: commit ? commit.slice(0, 8) : null,
    github:
      config?.project && task
        ? mergeOnGithub(config, task.merge?.repo ?? effectiveRepo({ project: config.project }, task) ?? '')
        : true,
    target,
  };
}

/** The same sentence on every path a move can be refused (the drawer, the board, a group, the inbox). */
export function mergeRefusal(error: unknown, facts: RefusalFacts): MergeRefusal | null {
  const refused = notMergedOf(error);
  if (!refused) return null;
  if (refused.reason === 'engine_unavailable')
    return { tone: 'error', text: t('task.merge.refused.engine'), mayMerge: false };
  const merger = refused.merger ?? '';
  const mayMerge = !!merger && merger === facts.myHandle;
  const name = nameOf(merger, facts.members, facts.myHandle);
  const base = refused.base;
  if (refused.reason === 'not_on_remote') {
    const remote = facts.github === false;
    return {
      tone: mayMerge ? 'error' : 'info',
      mayMerge,
      text: mayMerge
        ? t(remote ? 'task.merge.refused.notOnRemoteMergerRemote' : 'task.merge.refused.notOnRemoteMerger', {
            base,
          })
        : t(remote ? 'task.merge.refused.notOnRemoteRemote' : 'task.merge.refused.notOnRemote', {
            base,
            merger: name,
          }),
    };
  }
  return mayMerge
    ? {
        tone: 'error',
        mayMerge,
        text: t('task.merge.refused.notMergedMerger', {
          what: mergeWhat(facts.commit ?? null, true),
          base,
        }),
      }
    : {
        tone: 'info',
        mayMerge,
        text: t('task.merge.refused.notMerged', { merger: name, base, target: facts.target }),
      };
}

/** What the merge's failure was, as the words of the card: "ütközés" or "elbukott az ellenőrzés". */
export function failureKind(merge: Pick<TaskMergeState, 'failure'>): 'conflict' | 'check_failed' {
  return merge.failure?.reason === 'check_failed' ? 'check_failed' : 'conflict';
}

/** The handle of whoever merges the card: the open merge's, else the one the configuration names; null: nobody. */
export function mergerHandleOf(task: Task, config: MergeConfig | undefined): string | null {
  return task.merge?.merger ?? (config ? cardMerger(config, task, null) : null);
}

/** Who merges, as a name for the viewer (the viewer's own name reads "Te"). */
export function mergerName(
  merge: Pick<TaskMergeState, 'merger'>,
  members: MemberIndex,
  myHandle: string | null,
) {
  return nameOf(merge.merger, members, myHandle);
}

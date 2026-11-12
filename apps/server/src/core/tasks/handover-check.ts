import { effectiveRepo, handoverCheckVerdict } from '@projectman/shared';
import type { HandoverCheckMiss, HandoverCheckRead, ProjectConfig, Task } from '@projectman/shared';
import type { SourceHead } from '../../contracts';
import { conflict } from '../../kernel';

/** Reads the hand-over check's result in the developer's workspace of a task (PM-1380). */
export type HandoverCheckReader = (config: ProjectConfig, task: Task) => Promise<HandoverCheckRead>;

/** A reason the developer gave for a commit the check could not run on; the caller records it as an event. */
export interface HandoverCheckException {
  commit: string;
  reason: string;
}

/** The hand-over check the task's repository asks for, or undefined. */
export function handoverCheckOf(config: ProjectConfig, task: Task) {
  const repoName = effectiveRepo(config, task);
  return config.project.repos.find((repo) => repo.name === repoName)?.handoverCheck;
}

const short = (commit: string) => commit.slice(0, 7);

/** What went wrong and what to do, per miss; the command is the repository's setting, word for word. */
function advice(
  miss: HandoverCheckMiss,
  command: string,
  commit: string,
  recordCommit: string | undefined,
): string {
  const run = `commit your work, run \`${command}\` in your workspace and try again`;
  const exception =
    'if your sandbox does not let it run (exit 78, a local port, a pseudo-terminal), give the reason with update_task handover_check_exception';
  switch (miss) {
    case 'no_record':
      return `no \`${command}\` result for commit ${short(commit)}. ${capital(run)}; ${exception}.`;
    case 'other_commit':
      return `no green \`${command}\` result for commit ${short(commit)} (the last run was on ${short(recordCommit ?? '')}). ${capital(run)}; ${exception}.`;
    case 'not_clean':
      return `the last \`${command}\` run on commit ${short(commit)} saw uncommitted changes, or the commit moved while it ran. ${capital(run)} without editing files meanwhile; ${exception}.`;
    case 'failed':
      return `\`${command}\` failed on commit ${short(commit)}. Fix what it reports, ${run}; ${exception}.`;
    case 'engine_outdated':
      return `the engine this card runs on is older than the server and cannot report the \`${command}\` result for commit ${short(commit)}. Ask the owner to update the engine, or give the reason with update_task handover_check_exception.`;
  }
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Whether the work at `head` may be handed over for review (PM-1380). Without a setting nothing is read. A commit
 * with a recorded exception passes. Without a green result it throws `handover_check_missing` naming the cause and
 * what to do, unless the caller gave a `reason`: then it returns the exception to record (the move or the new
 * review round goes on). Null: nothing to record.
 */
export async function assertHandoverCheck(input: {
  config: ProjectConfig;
  task: Task;
  head: SourceHead;
  /** What is refused, e.g. "enter Átnézés" or "start a new review round". */
  what: string;
  stageId: string;
  read: HandoverCheckReader;
  exceptionCommits: (task: Task) => readonly string[];
  reason?: string | undefined;
}): Promise<HandoverCheckException | null> {
  const { config, task, head, what, stageId, reason } = input;
  const setting = handoverCheckOf(config, task);
  if (!setting) return null;
  const exceptions = input.exceptionCommits(task);
  const record = exceptions.includes(head.commit) ? null : await input.read(config, task);
  const verdict = handoverCheckVerdict({ setting, commit: head.commit, record, exceptions });
  if (verdict.status !== 'missing') return null;
  if (reason) return { commit: head.commit, reason };
  throw conflict(
    'handover_check_missing',
    `task ${task.key} cannot ${what}: ${advice(verdict.miss, setting.command, head.commit, verdict.recordCommit)}`,
    {
      taskKey: task.key,
      stageId,
      command: setting.command,
      commit: head.commit,
      miss: verdict.miss,
      ...(verdict.recordCommit ? { recordCommit: verdict.recordCommit } : {}),
    },
  );
}

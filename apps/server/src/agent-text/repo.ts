import type { TextStyle } from './text';
import { PLAIN_STYLE } from './text';

/** Where a task's work happens, as the shared `effectiveRepo` and `needsRepoChoice` rules give it. */
export interface TaskRepoInfo {
  /** The repository the work happens in; null when there is none. */
  name: string | null;
  /** The project has several repositories and the task names none: a person has to choose. */
  choiceNeeded: boolean;
}

/**
 * The repository of a task as an AI member reads it: its name, or why there is none. A project
 * without repositories works in the workspace root; a project with several and no choice yet has no
 * place for work that changes files (such a session does not start, see `repo_required`), and the
 * members that only read are told to ask which one it is.
 */
export function describeRepo(repo: TaskRepoInfo, style: Pick<TextStyle, 'code'> = PLAIN_STYLE): string {
  if (repo.name) return style.code(repo.name);
  return repo.choiceNeeded
    ? 'none chosen yet (the project has several repositories; ask a human which one if you need to know)'
    : 'the workspace root';
}

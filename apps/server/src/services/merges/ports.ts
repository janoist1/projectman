import type { EngineId, ProjectConfig, Session, Task } from '@projectman/shared';
import type { FullTestSandbox, SourceHead } from '../../contracts';

/** What the merges need from the session orchestrator (the real one satisfies it structurally). */
export interface MergeSessions {
  sourceHead(config: ProjectConfig, task: Task, opts?: { strict?: boolean }): Promise<SourceHead | null>;
  cardEngineId(projectKey: string, task: Task): EngineId;
  list(projectKey: string, filter?: { member?: string; taskKey?: string }): Session[];
  isRunning(sessionId: string): boolean;
}

/** Another user of a repository's slot (the Operator's document writes, PM-495). */
export interface MergeSlotPeer {
  busy(projectKey: string, repo: string): boolean;
  pump(): void;
}

/** Builds the sandbox of the merge check's full test (`fullTestSandbox` of the session policy). */
export type MergeCheckSandbox = (input: {
  checkout: string;
  gitDir?: string;
  userHome: string;
  appHome?: string;
  closedTmpRoots?: readonly string[];
}) => FullTestSandbox;

import type { EngineId, ProjectConfig, Session, SessionStop, Task } from '@projectman/shared';
import type { FullTestSandbox, ScreenshotScope, SourceHead } from '../../contracts';

/** The session operations used by full test runs. */
export interface FullTestSessions {
  sourceHead(config: ProjectConfig, task: Task, opts?: { strict?: boolean }): Promise<SourceHead | null>;
  cardEngineId(projectKey: string, task: Task): EngineId;
  list(projectKey: string, filter?: { member?: string; taskKey?: string }): Session[];
  isRunning(sessionId: string): boolean;
  stop(projectKey: string, sessionId: string, stop?: SessionStop): Promise<Session>;
}

export type FullTestRunSandbox = (input: {
  checkout: string;
  gitDir?: string;
  userHome: string;
  appHome?: string;
  closedTmpRoots?: readonly string[];
}) => FullTestSandbox;

export interface ScreenshotSessions {
  screenshotScope(sessionId: string): ScreenshotScope | undefined;
}

export type OutputTailOf = (output: string, limit: number) => string;

import type { Task } from '@projectman/shared';
import type { EngineDirectory, GithubService } from '../../contracts';
import type { MergeRecord, MergeTrainRecord } from '../../db';
import type { BackgroundTasks } from '../../kernel';
import type { DomainContext } from '../../core/base';
import type { InboxService } from '../../core/inbox';
import type { Messaging } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import type { MergeCardLock } from '../../kernel';
import type { MergeCheckSandbox, MergeSessions } from './ports';

export type MergeDeps = {
  cards?: MergeCardLock;
  ctx: DomainContext;
  projects: ProjectService;
  tasks: TaskService;
  sessions: MergeSessions;
  messaging: Messaging;
  timeline: TimelineService;
  engines: EngineDirectory;
  github: GithubService;
  inbox: InboxService;
  background: BackgroundTasks;
  checkSandbox: MergeCheckSandbox;
  afterMerge: (task: Task) => Promise<void>;
};

/** The merge a repository's slot runs. The queue creates it; `signal` is set when the run starts. */
export type MergeRun = {
  readonly row: MergeRecord;
  train?: MergeTrainRecord;
  recoveryOnly?: boolean;
  pushing: boolean;
  signal?: AbortSignal;
};

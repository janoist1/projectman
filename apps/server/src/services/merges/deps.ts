import type { Task } from '@projectman/shared';
import type { EngineDirectory, GithubService } from '../../contracts';
import type { MergeRecord } from '../../db';
import type { BackgroundTasks } from '../../domain/background';
import type { DomainContext } from '../../domain/context';
import type { InboxService } from '../../domain/inbox';
import type { Messaging } from '../../domain/messaging';
import type { ProjectService } from '../../domain/projects';
import type { TaskService } from '../../domain/tasks';
import type { TimelineService } from '../../domain/timeline';
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
export type MergeRun = { readonly row: MergeRecord; pushing: boolean; signal?: AbortSignal };

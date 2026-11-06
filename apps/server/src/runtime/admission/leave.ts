import { membersSentOnLeave } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { ConfigChange } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { BackgroundTasks } from '../../kernel';
import type { RefinementSteps } from './refinement';

interface LeaveReleaseDeps {
  tasks: Pick<TaskService, 'releaseOnLeave'>;
  refinement: Pick<RefinementSteps, 'releaseOnLeave'>;
  /** Asks for a retry of the deferred starts (`Admission.requestRetry`). */
  retry: () => void;
  background: Pick<BackgroundTasks, 'run'>;
  logger: DomainContext['logger'];
}

/**
 * Sending a member on leave takes it off what it carried (PM-1300): its open cards lose it as assignee,
 * its open refinement turns are handed out again, and the deferred starts that waited for it are tried
 * again, so the usual pick moves them (and their queue items) to a member at work. Nothing is handed to
 * anyone by name: whoever set the leave arranges the replacement. The messages for it still wait, and a
 * call-back gives nothing back.
 */
export class LeaveRelease {
  private readonly deps: LeaveReleaseDeps;

  constructor(deps: LeaveReleaseDeps) {
    this.deps = deps;
  }

  configChanged(change: Pick<ConfigChange, 'projectKey' | 'previous' | 'next' | 'actor'>): void {
    const { tasks, refinement, retry, background, logger } = this.deps;
    const handles = membersSentOnLeave(change.previous, change.next);
    if (handles.length === 0) return;
    for (const handle of handles) tasks.releaseOnLeave(change.projectKey, handle, change.actor);
    // In the background: the next pick of a refinement turn starts a session, which must not hold back
    // the configuration change's later listeners.
    background.run(
      async () => {
        try {
          for (const handle of handles) await refinement.releaseOnLeave(change.projectKey, handle);
        } finally {
          retry();
        }
      },
      (err) =>
        logger.warn(
          { err, projectKey: change.projectKey },
          'could not hand out the turns of a member on leave',
        ),
    );
  }
}

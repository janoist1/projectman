import { membersSentOnLeave } from '@projectman/shared';
import type { ConfigChange } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { RefinementSteps } from './refinement';

/**
 * Sending a member on leave takes it off what it carried (PM-1300): its open cards lose it as assignee,
 * its open refinement turns are handed out again, and the deferred starts that waited for it are tried
 * again, so the usual pick moves them (and their queue items) to a member at work. Nothing is handed to
 * anyone by name: whoever set the leave arranges the replacement. The messages for it still wait, and a
 * call-back gives nothing back.
 */
export class LeaveRelease {
  private readonly tasks: Pick<TaskService, 'releaseOnLeave'>;
  private readonly refinement: Pick<RefinementSteps, 'releaseOnLeave'>;
  private readonly retry: () => void;

  constructor(deps: {
    tasks: Pick<TaskService, 'releaseOnLeave'>;
    refinement: Pick<RefinementSteps, 'releaseOnLeave'>;
    /** Asks for a retry of the deferred starts (`Admission.requestRetry`). */
    retry: () => void;
  }) {
    this.tasks = deps.tasks;
    this.refinement = deps.refinement;
    this.retry = deps.retry;
  }

  async configChanged(
    change: Pick<ConfigChange, 'projectKey' | 'previous' | 'next' | 'actor'>,
  ): Promise<void> {
    const handles = membersSentOnLeave(change.previous, change.next);
    if (handles.length === 0) return;
    for (const handle of handles) {
      this.tasks.releaseOnLeave(change.projectKey, handle, change.actor);
      await this.refinement.releaseOnLeave(change.projectKey, handle);
    }
    this.retry();
  }
}

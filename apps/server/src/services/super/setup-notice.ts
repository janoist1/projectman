import { coordinationMemberOf } from '@projectman/shared';
import type { SuperOperation } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import { isAppOperation } from './app';

/** What a setup package's commit did (PM-1460), as its `setup_applied` timeline event records it. */
export interface SetupResult {
  previousVersion: string;
  version: string;
  hired: string[];
  updated: string[];
  agreement: 'written' | 'not_written' | 'none';
  agreementError?: string;
}

/** The project manager's system messages about its setup package: what was applied, or why nothing was. */
export interface SetupNotices {
  applied(operation: SuperOperation, title: string, result: SetupResult): Promise<void>;
  /** A finished package that did not succeed; a superseded one says nothing, its successor is the news. */
  finished(operation: SuperOperation): Promise<void>;
}

const titleOf = (operation: SuperOperation): string | null =>
  operation.command.kind === 'operate' && operation.command.operation.op === 'setup_apply'
    ? operation.command.operation.title
    : null;

const list = (handles: readonly string[]): string => (handles.length ? handles.join(', ') : 'none');

function appliedText(title: string, result: SetupResult): string {
  const agreement =
    result.agreement === 'written'
      ? 'The shared agreement was replaced.'
      : result.agreement === 'not_written'
        ? `The shared agreement was NOT written (${result.agreementError ?? 'internal_error'}): the configuration ` +
          'stays applied; propose the agreement again on its own.'
        : 'The package had no agreement.';
  // The way back (PM-1463): one revert, which also undoes later configuration changes and leaves the agreement.
  const revert =
    `To undo it, config_revert to ${result.previousVersion} restores the configuration in one step; it also ` +
    'undoes the configuration changes made since, removing hired members waits for the owner’s yes, and the ' +
    'agreement is not part of the configuration, so propose the old one again on its own if needed.';
  return (
    `Setup package "${title}" is applied in one configuration commit ` +
    `(${result.previousVersion} -> ${result.version}). Hired: ${list(result.hired)}. ` +
    `Changed members: ${list(result.updated)}. ${agreement} ${revert}`
  );
}

function notAppliedText(title: string, operation: SuperOperation): string {
  const why = operation.errorCode ?? operation.state;
  if (operation.state === 'unknown')
    return (
      `Setup package "${title}" stopped with an unknown outcome (${why}). Check the configuration history ` +
      'before proposing it again.'
    );
  return `Setup package "${title}" was not applied (${why}). Nothing of it was changed.`;
}

/** Only the in-app project manager's own packages: a connected client reads its operation itself. */
export function createSetupNotices(deps: {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'cachedConfig'>;
  send(projectKey: string, to: string, text: string): Promise<unknown>;
}): SetupNotices {
  const notify = async (operation: SuperOperation, text: string): Promise<void> => {
    try {
      if (!isAppOperation(deps.ctx, operation)) return;
      const config = deps.projects.cachedConfig(operation.projectKey);
      const projectManager = config && coordinationMemberOf(config)?.handle;
      if (projectManager) await deps.send(operation.projectKey, projectManager, text);
    } catch (err) {
      deps.ctx.logger.warn({ err, operationId: operation.id }, 'setup package notice was not sent');
    }
  };
  return {
    applied: (operation, title, result) => notify(operation, appliedText(title, result)),
    finished: async (operation) => {
      const title = titleOf(operation);
      if (title === null || operation.state === 'succeeded') return;
      if (operation.errorCode === 'super_operation_superseded') return;
      await notify(operation, notAppliedText(title, operation));
    },
  };
}

import type { Task } from '@projectman/shared';
import { effectiveRepo, needsRepoChoice } from '@projectman/shared';
import { useConfig, useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { isTaskClosed } from '../../lib/taskState';
import drawer from './drawer.module.css';
import styles from './TaskRepo.module.css';

/**
 * Where the task's work happens, for the drawer's facts: the repository (the task's own, else the
 * project's only one, the same rule the server places sessions by), or that none is chosen yet. In
 * a project with several repositories, whoever may edit the task picks it from a compact select that
 * saves on change. The configuration holds the repositories; members without access to it see the
 * task's own repository only.
 */
export function TaskRepo({ task }: { task: Task }) {
  const { key, can } = useProject();
  const config = useConfig(key, can.createTasks).data?.config;
  const update = useUpdateTask(key);
  const repos = config?.project.repos ?? [];

  if (can.createTasks && repos.length > 1 && !isTaskClosed(task)) {
    // While the change is saved the select shows what was picked, then what the server holds.
    const picked = update.isPending ? (update.variables?.body.repo ?? null) : task.repo;
    const unknown = task.repo !== null && !repos.some((repo) => repo.name === task.repo);
    return (
      <>
        <label className={styles.repo}>
          <span>{t('task.repoLabel')}</span>
          <select
            className={styles.select}
            value={picked ?? ''}
            data-unset={picked === null ? 'true' : undefined}
            disabled={update.isPending}
            onChange={(event) =>
              update.mutate({ taskKey: task.key, body: { repo: event.target.value || null } })
            }
          >
            <option value="">{t('task.repoNone')}</option>
            {/* A repository the configuration no longer has stays visible until another is picked. */}
            {unknown ? <option value={task.repo!}>{task.repo}</option> : null}
            {repos.map((repo) => (
              <option key={repo.name} value={repo.name}>
                {repo.name}
              </option>
            ))}
          </select>
        </label>
        {update.isError ? (
          <span role="alert" className={drawer.error}>
            {errorMessage(update.error)}
          </span>
        ) : null}
      </>
    );
  }

  const repo = config ? effectiveRepo(config, task) : task.repo;
  if (repo) return <span>{t('task.repo', { repo })}</span>;
  if (!config) return null;
  return (
    <span>
      {needsRepoChoice(config, task) ? t('task.repoNone') : t('task.repo', { repo: t('task.workspaceRoot') })}
    </span>
  );
}

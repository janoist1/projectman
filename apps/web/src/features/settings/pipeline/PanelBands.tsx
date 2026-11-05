import clsx from 'clsx';
import type { ProjectConfig } from '@projectman/shared';
import { t } from '../../../i18n/t';
import type { FieldIssue } from '../edit/FieldErrors';
import type { ElementEdit } from '../edit/useElementEdit';
import styles from './StagePanel.module.css';

/** The band over a panel's form: the element is gone, someone else saved first, or this save was refused. */
export function PanelBands({
  edit,
  config,
  other,
}: {
  edit: Pick<ElementEdit<unknown>, 'gone' | 'conflict' | 'failure'>;
  config: ProjectConfig;
  /** The refused errors that belong to no field of the form. */
  other: readonly FieldIssue[];
}) {
  if (edit.gone)
    return (
      <p className={clsx(styles.band, styles.warning)} role="status">
        {t('settings.pipeline.edit.gone')}
      </p>
    );
  if (edit.conflict) {
    const author = edit.conflict.author;
    const name = config.team.members.find((member) => member.handle === author)?.displayName ?? author;
    return (
      <p className={clsx(styles.band, styles.warning)} role="status">
        {t('settings.pipeline.edit.conflict', { name })}
      </p>
    );
  }
  if (edit.failure?.kind === 'owner_only')
    return (
      <p className={clsx(styles.band, styles.danger)} role="alert">
        {t('settings.pipeline.edit.ownerOnly')}
      </p>
    );
  if (edit.failure?.kind === 'error')
    return (
      <p className={clsx(styles.band, styles.danger)} role="alert">
        {edit.failure.reason
          ? t('settings.pipeline.edit.failed', { reason: edit.failure.reason })
          : t('settings.pipeline.edit.failedNetwork')}
      </p>
    );
  if (other.length > 0)
    return (
      <div className={clsx(styles.band, styles.danger)} role="alert">
        <p>
          {t('settings.pipeline.edit.failed', {
            reason: other.map((issue) => issue.message).join(' '),
          })}
        </p>
        <details>
          <summary>{t('settings.pipeline.edit.details')}</summary>
          {other.map((issue) => (
            <code key={`${issue.code}:${issue.path}`}>
              {issue.code} · {issue.path}
            </code>
          ))}
        </details>
      </div>
    );
  return null;
}

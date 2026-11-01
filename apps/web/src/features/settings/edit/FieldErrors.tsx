import { Icon } from '../../../components/Icon';
import { t } from '../../../i18n/t';
import styles from './FieldErrors.module.css';

/** One refusal at a field: a sentence, and the technical code and path behind it. */
export interface FieldIssue {
  message: string;
  code: string;
  path: string;
}

/** The errors under a field, each with its code and path under "Részletek". */
export function FieldErrors({ id, issues }: { id?: string; issues: readonly FieldIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div id={id} className={styles.errors}>
      {issues.map((issue) => (
        <div key={`${issue.code}:${issue.path}`} className={styles.error}>
          <p role="alert">
            <Icon name="exclamation" size={13} /> {issue.message}
          </p>
          <details>
            <summary>{t('settings.pipeline.edit.details')}</summary>
            <code>
              {issue.code} · {issue.path}
            </code>
          </details>
        </div>
      ))}
    </div>
  );
}

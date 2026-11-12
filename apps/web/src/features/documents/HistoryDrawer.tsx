import { useEffect, useRef } from 'react';
import { useDocumentHistory } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { ActorName } from '../../components/ActorName';
import { Button } from '../../components/Button';
import { ErrorState, LoadingState } from '../../components/States';
import { formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { isPageEscape } from '../../lib/hooks';
import { authorLabel } from './authorLabel';
import { changeMessage } from './changeMessage';
import styles from './HistoryDrawer.module.css';

interface Props {
  slug: string;
  /** The newest version of the document: its row is marked as the current one. */
  currentVersion: string;
  /** The older version the page shows, if any. */
  viewingVersion?: string;
  onView: (version: string) => void;
  onClose: () => void;
}

/** The versions of a document, newest first, in a panel at the right (PM-150). Esc closes it. */
export function HistoryDrawer({ slug, currentVersion, viewingVersion, onView, onClose }: Props) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const history = useDocumentHistory(key, slug, true);
  const heading = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    heading.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (isPageEscape(event)) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const versions = history.data?.versions ?? [];
  return (
    <aside className={styles.drawer} aria-label={t('documents.history.title')}>
      <div className={styles.head}>
        <h2 ref={heading} tabIndex={-1} className={styles.title}>
          {t('documents.history.title')}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          aria-label={t('documents.history.close')}
          onClick={onClose}
        />
      </div>
      {history.isPending ? <LoadingState compact /> : null}
      {history.isError ? (
        <ErrorState error={history.error} compact onRetry={() => void history.refetch()} />
      ) : null}
      <ol className={styles.list}>
        {versions.map((version, index) => {
          // A rename shows when the title differs from the one before it.
          const earlier = versions[index + 1];
          const renamed = earlier && earlier.title !== version.title;
          const current =
            version.version === currentVersion ? (
              <span className={styles.current}>{t('documents.history.current')}</span>
            ) : null;
          return (
            <li key={version.version} className={styles.row}>
              <div className={styles.meta}>
                <time dateTime={version.at}>{formatStamp(version.at)}</time>
                {version.by.actor ? (
                  <span className={styles.author}>
                    <ActorName
                      actor={version.by.actor}
                      members={members}
                      myHandle={myHandle}
                      projectKey={key}
                      history
                      after={current}
                    />
                  </span>
                ) : (
                  <>
                    <span>{authorLabel(version.by, members, myHandle)}</span>
                    {current}
                  </>
                )}
              </div>
              <p className={styles.message}>{changeMessage(version, slug)}</p>
              {renamed ? (
                <p className={styles.renamed}>{t('documents.history.renamed', { title: version.title })}</p>
              ) : null}
              {version.deleted ? null : version.version === viewingVersion ||
                (version.version === currentVersion && !viewingVersion) ? (
                <span className={styles.viewing}>{t('documents.history.viewing')}</span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onView(version.version)}
                  aria-label={t('documents.history.viewAt', { time: formatStamp(version.at) })}
                >
                  {t('documents.history.view')}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

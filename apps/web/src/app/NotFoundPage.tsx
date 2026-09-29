import { ButtonLink } from '../components/Button';
import { EmptyState } from '../components/States';
import { t } from '../i18n/t';
import { useDocumentTitle } from '../lib/hooks';
import styles from './App.module.css';

/** Unknown page or project: a heading, a title and the way back. */
export function NotFoundPage({ message }: { message: string }) {
  useDocumentTitle(message);
  return (
    <div className={styles.notFound}>
      <EmptyState
        icon="exclamation"
        title={message}
        titleAs="h1"
        action={
          <ButtonLink to="/" variant="secondary">
            {t('app.backHome')}
          </ButtonLink>
        }
      />
    </div>
  );
}

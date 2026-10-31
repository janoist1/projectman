import { Link, useNavigate, useSearchParams } from 'react-router';
import { useDocuments } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { useDocumentTitle } from '../../lib/hooks';
import { useDocumentAccess } from './access';
import { DocumentEditor } from './DocumentEditor';
import { documentsPath } from './paths';
import styles from './DocumentsPage.module.css';

/**
 * The project's living documents (PM-150): newest change first. `?new=1` opens the editor of a new
 * document. A client never gets here (the route sends them to the project's home).
 */
export function DocumentsPage() {
  const { key } = useProject();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const access = useDocumentAccess();
  const list = useDocuments(key, access.read);
  useDocumentTitle(t('documents.title'));
  const creating = params.get('new') === '1' && access.edit;

  if (creating) {
    return (
      <div className={styles.page}>
        <PageHeader title={t('documents.editor.newTitle')} />
        <DocumentEditor
          initial={{ title: '', content: '' }}
          onSaved={({ document }) => {
            toast.show(t('documents.editor.created'));
            void navigate(documentsPath(key, document.slug));
          }}
          onCancel={() => setParams({})}
        />
      </div>
    );
  }

  const documents = list.data?.documents ?? [];
  return (
    <div className={styles.page}>
      <PageHeader title={t('documents.title')} subtitle={t('documents.intro')}>
        {access.edit ? (
          <Button variant="primary" size="md" icon="plus" onClick={() => setParams({ new: '1' })}>
            {t('documents.new')}
          </Button>
        ) : null}
      </PageHeader>
      {list.isPending ? <LoadingState /> : null}
      {list.isError ? (
        <ErrorState
          error={list.error}
          message={t('documents.loadError')}
          onRetry={() => void list.refetch()}
        />
      ) : null}
      {list.data && documents.length === 0 ? (
        <EmptyState
          icon="doc"
          tone="neutral"
          title={t('documents.empty.title')}
          body={access.edit ? t('documents.empty.body') : t('documents.empty.bodyReadOnly')}
        />
      ) : null}
      {documents.length > 0 ? (
        <ul className={styles.list} aria-label={t('documents.listLabel')}>
          {documents.map((document) => (
            <li key={document.slug}>
              <Link to={documentsPath(key, document.slug)} className={styles.row}>
                <Icon name="doc" size={20} />
                <span className={styles.text}>
                  <span className={styles.name}>{document.title}</span>
                  <span className={styles.sub}>
                    <code>{document.slug}</code>
                    <span>{t('documents.updatedBy', { name: document.updatedBy.name })}</span>
                    <time dateTime={document.updatedAt}>{formatStamp(document.updatedAt)}</time>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

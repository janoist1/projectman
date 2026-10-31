import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { documentOutline, documentSection } from '@projectman/shared';
import type { DocumentHeading } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { useDeleteDocument, useDocument, useRestoreDocument } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button, ButtonLink } from '../../components/Button';
import { Dialog, DialogActions } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Fold } from '../../components/Fold';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import type { HeadingLinks } from '../../components/Markdown';
import { MoreMenu } from '../../components/MoreMenu';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useDocumentTitle } from '../../lib/hooks';
import { useDocumentAccess } from './access';
import { DocumentEditor } from './DocumentEditor';
import { HistoryDrawer } from './HistoryDrawer';
import { documentRef, documentsPath } from './paths';
import styles from './DocumentPage.module.css';

const HIGHLIGHT_MS = 2000;

const decoded = (hash: string): string => {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
};

/**
 * One document (PM-150): the formatted text with a section outline, the editor (`?edit=1`), an older
 * version (`?version=`), the history drawer, and `#section` links that scroll to a heading.
 */
export function DocumentPage() {
  const { key } = useProject();
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const client = useQueryClient();
  const access = useDocumentAccess();
  const version = params.get('version') ?? undefined;
  const editing = params.get('edit') === '1' && access.edit && !version;
  // Both read the same cache entry when no older version is open.
  const currentQ = useDocument(key, slug);
  const shownQ = useDocument(key, slug, version);
  const restore = useRestoreDocument(key, slug);
  const remove = useDeleteDocument(key, slug);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [missingSection, setMissingSection] = useState<string | null>(null);

  const detail = shownQ.data;
  const current = currentQ.data;
  useDocumentTitle(detail?.document.title ?? t('documents.title'));
  const outline = useMemo(() => (detail ? documentOutline(detail.content) : []), [detail]);
  const hash = location.hash.slice(1);

  // Arriving with `#section`: scroll to the heading, highlight it for a moment; an unknown section
  // leaves the top and says so.
  const text = detail?.content;
  useEffect(() => {
    if (text === undefined || !hash || editing) return;
    const found = documentSection(text, decoded(hash));
    const target = found ? document.getElementById(found.heading.anchor) : null;
    if (!target) {
      setMissingSection(decoded(hash));
      window.history.replaceState(null, '', location.pathname + location.search);
      return;
    }
    setMissingSection(null);
    target.scrollIntoView?.({ block: 'start' });
    target.focus({ preventScroll: true });
    target.setAttribute('data-active', 'true');
    const timer = window.setTimeout(() => target.removeAttribute('data-active'), HIGHLIGHT_MS);
    return () => {
      window.clearTimeout(timer);
      target.removeAttribute('data-active');
    };
  }, [text, hash, editing, location.pathname, location.search]);

  const headingLinks = useMemo<HeadingLinks>(
    () => ({
      copyLabel: (heading) => t('documents.section.copy', { title: heading.text }),
      onCopy: (heading) => {
        const ref = documentRef(slug, heading.anchor);
        window.history.replaceState(null, '', `${location.pathname}${location.search}#${heading.anchor}`);
        void (async () => {
          try {
            await navigator.clipboard.writeText(ref);
            toast.show(t('documents.section.copied', { ref }));
          } catch {
            toast.show(t('documents.section.copyFailed'), 'error');
          }
        })();
      },
    }),
    [slug, location.pathname, location.search, toast],
  );

  const jumpTo = (heading: DocumentHeading) => {
    const target = document.getElementById(heading.anchor);
    target?.scrollIntoView?.({ block: 'start' });
    target?.focus({ preventScroll: true });
    window.history.replaceState(null, '', `${location.pathname}${location.search}#${heading.anchor}`);
  };

  const copySlug = async () => {
    try {
      await navigator.clipboard.writeText(slug);
      toast.show(t('documents.slug.copied'));
    } catch {
      toast.show(t('documents.section.copyFailed'), 'error');
    }
  };

  const toList = () => navigate(documentsPath(key));
  const leaveEdit = () => setParams({});

  if (!detail) {
    if (shownQ.isPending) return <LoadingState />;
    const gone = isApiError(shownQ.error) && shownQ.error.code === 'document_not_found';
    return (
      <div className={styles.page}>
        {gone ? (
          <EmptyState
            icon="doc"
            titleAs="h1"
            title={t('documents.notFound.title')}
            body={t('documents.notFound.body')}
            action={
              <ButtonLink to={documentsPath(key)} variant="secondary" size="md">
                {t('documents.notFound.back')}
              </ButtonLink>
            }
          />
        ) : (
          <ErrorState error={shownQ.error} onRetry={() => void shownQ.refetch()} />
        )}
      </div>
    );
  }

  const { document: summary } = detail;
  const currentVersion = current?.document.version ?? summary.version;
  const goneWhileEditing =
    currentQ.isError && isApiError(currentQ.error) && currentQ.error.code === 'document_not_found';

  if (editing) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>{t('documents.editor.editTitle', { title: summary.title })}</h1>
        <DocumentEditor
          key={slug}
          slug={slug}
          initial={{ title: summary.title, content: detail.content, version: summary.version }}
          latestVersion={current?.document.version}
          gone={goneWhileEditing}
          onSaved={() => {
            toast.show(t('documents.editor.saved'));
            leaveEdit();
          }}
          onCancel={leaveEdit}
        />
      </div>
    );
  }

  const confirmRestore = () =>
    restore.mutate(
      { version: summary.version, baseVersion: currentVersion },
      {
        onSuccess: () => {
          toast.show(t('documents.version.restored'));
          setRestoreOpen(false);
          void navigate(documentsPath(key, slug));
        },
        onError: (failure) => {
          if (isApiError(failure) && failure.code === 'document_conflict') {
            toast.show(t('documents.version.restoreStale'), 'error');
            void client.invalidateQueries({ queryKey: queryKeys.documentHistory(key, slug) });
            setRestoreOpen(false);
          }
        },
      },
    );

  const confirmDelete = () =>
    remove.mutate(currentVersion, {
      onSuccess: () => {
        toast.show(t('documents.delete.done', { title: summary.title }));
        setDeleteOpen(false);
        void toList();
      },
    });

  return (
    <div className={styles.page}>
      <ButtonLink
        to={documentsPath(key)}
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        className={styles.back}
      >
        {t('documents.title')}
      </ButtonLink>
      <header className={styles.header}>
        <h1 className={styles.title}>{summary.title}</h1>
        <div className={styles.meta}>
          <button
            type="button"
            className={styles.slug}
            aria-label={t('documents.slug.copy', { slug })}
            onClick={() => void copySlug()}
          >
            <Icon name="link" size={14} strokeWidth={2.2} />
            <code>{slug}</code>
          </button>
          <span>
            {t('documents.updatedBy', { name: summary.updatedBy.name })} ·{' '}
            <time dateTime={summary.updatedAt}>{formatStamp(summary.updatedAt)}</time>
          </span>
        </div>
        {!version ? (
          <div className={styles.actions}>
            {access.edit ? (
              <Button variant="primary" size="md" icon="pencil" onClick={() => setParams({ edit: '1' })}>
                {t('documents.edit')}
              </Button>
            ) : null}
            <Button variant="secondary" size="md" icon="history" onClick={() => setHistoryOpen(true)}>
              {t('documents.history.title')}
            </Button>
            {access.del ? (
              <MoreMenu label={t('documents.more')}>
                {(close) => (
                  <Button
                    variant="ghost"
                    icon="trash"
                    onClick={() => {
                      setDeleteOpen(true);
                      close();
                    }}
                  >
                    {t('documents.delete.action')}
                  </Button>
                )}
              </MoreMenu>
            ) : null}
          </div>
        ) : null}
      </header>

      {version ? (
        <div className={styles.banner} role="status">
          <span>
            {t('documents.version.banner', {
              time: formatStamp(summary.updatedAt),
              name: summary.updatedBy.name,
            })}
          </span>
          <span className={styles.bannerActions}>
            {access.edit ? (
              <Button size="sm" variant="primary" icon="undo" onClick={() => setRestoreOpen(true)}>
                {t('documents.version.restore')}
              </Button>
            ) : null}
            <ButtonLink to={documentsPath(key, slug)} size="sm" variant="secondary">
              {t('documents.version.back')}
            </ButtonLink>
            <Button size="sm" variant="secondary" icon="history" onClick={() => setHistoryOpen(true)}>
              {t('documents.history.title')}
            </Button>
          </span>
        </div>
      ) : null}

      {missingSection ? (
        <div className={styles.banner} role="status">
          <span>{t('documents.section.missing', { section: missingSection })}</span>
          <Button size="sm" variant="ghost" onClick={() => setMissingSection(null)}>
            {t('common.close')}
          </Button>
        </div>
      ) : null}

      {outline.length >= 3 ? (
        <Fold summary={t('documents.toc.count', { count: outline.length })} className={styles.toc}>
          <ul className={styles.tocList}>
            {outline.map((heading) => (
              <li key={heading.anchor} style={{ paddingLeft: `${(heading.level - 1) * 14}px` }}>
                <a
                  href={`#${heading.anchor}`}
                  onClick={(event) => {
                    event.preventDefault();
                    jumpTo(heading);
                  }}
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ul>
        </Fold>
      ) : null}

      {detail.content.trim() ? (
        <Markdown text={detail.content} className={styles.body} headingLinks={headingLinks} />
      ) : (
        <p className={styles.emptyContent}>{t('documents.emptyContent')}</p>
      )}

      {historyOpen ? (
        <HistoryDrawer
          slug={slug}
          currentVersion={currentVersion}
          viewingVersion={version}
          onView={(next) => setParams({ version: next })}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}

      <Dialog
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        title={t('documents.version.restoreTitle')}
        size="sm"
      >
        <p>{t('documents.version.restoreBody')}</p>
        <DialogActions
          error={restore.error ? <ErrorBanner>{errorMessage(restore.error)}</ErrorBanner> : null}
        >
          <Button variant="secondary" size="md" onClick={() => setRestoreOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="md" loading={restore.isPending} onClick={confirmRestore}>
            {t('documents.version.restore')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t('documents.delete.title')}
        size="sm"
      >
        <p>{t('documents.delete.body', { title: summary.title })}</p>
        <DialogActions error={remove.error ? <ErrorBanner>{errorMessage(remove.error)}</ErrorBanner> : null}>
          <Button variant="secondary" size="md" onClick={() => setDeleteOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="dangerSolid" size="md" loading={remove.isPending} onClick={confirmDelete}>
            {t('documents.delete.action')}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}

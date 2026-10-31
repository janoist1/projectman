import { useEffect, useState } from 'react';
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_TITLE_LENGTH } from '@projectman/shared';
import type { DocumentDetail } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import { useCreateDocument, useUpdateDocument } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { DescriptionEditor } from '../../components/DescriptionEditor';
import { Dialog, DialogActions } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TextField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toastContext';
import { numberFormat } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import styles from './DocumentEditor.module.css';

const BYTES_SHOWN_FROM = MAX_DOCUMENT_BYTES * 0.8;
const byteLength = (text: string) => new TextEncoder().encode(text).length;

interface Props {
  /** Edit: the document being changed; create: absent. */
  slug?: string;
  /** The text the editor starts from, with the version it was read at (edit). */
  initial: { title: string; content: string; version?: string };
  /** The newest version the page knows (live); a different one than the base means someone else saved. */
  latestVersion?: string;
  /** The document was deleted while it is being edited. */
  gone?: boolean;
  onSaved: (detail: DocumentDetail) => void;
  onCancel: () => void;
}

/** The text of a save that did not go through, kept beside the editor (PM-150). */
interface KeptText {
  title: string;
  content: string;
}

/**
 * Create and edit in one form (PM-150). A save sends the version the text was read at; when someone saved
 * in between (409) nothing is lost: the own text can be copied or kept beside the fresh version.
 */
export function DocumentEditor({ slug, initial, latestVersion, gone, onSaved, onCancel }: Props) {
  const { key } = useProject();
  const toast = useToast();
  const create = useCreateDocument(key);
  const update = useUpdateDocument(key, slug ?? '');
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [message, setMessage] = useState('');
  const [base, setBase] = useState(initial.version ?? '');
  const [base0] = useState(initial);
  const [kept, setKept] = useState<KeptText | null>(null);
  const [conflict, setConflict] = useState(false);
  const [loadingFresh, setLoadingFresh] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [freshError, setFreshError] = useState<unknown>(null);

  const dirty = title !== base0.title || content !== base0.content || kept !== null;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const saving = create.isPending || update.isPending;
  const stale = Boolean(slug && latestVersion && latestVersion !== base);
  const bytes = byteLength(content);
  const error = create.error ?? update.error;
  const showError = error && !(isApiError(error) && error.code === 'document_conflict');

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show(done);
    } catch {
      toast.show(t('documents.section.copyFailed'), 'error');
    }
  };

  const submit = () => {
    if (saving || gone || !title.trim()) return;
    setConflict(false);
    if (!slug) {
      create.mutate(
        { title: title.trim(), content, ...(message.trim() ? { message: message.trim() } : {}) },
        { onSuccess: onSaved },
      );
      return;
    }
    update.mutate(
      {
        baseVersion: base,
        title: title.trim(),
        content,
        ...(message.trim() ? { message: message.trim() } : {}),
      },
      {
        onSuccess: onSaved,
        onError: (failure) => {
          if (isApiError(failure) && failure.code === 'document_conflict') setConflict(true);
        },
      },
    );
  };

  /** Loads the newest text and keeps the own one in a box, so a merge is a copy away. */
  const loadFresh = async () => {
    if (!slug) return;
    setLoadingFresh(true);
    setFreshError(null);
    try {
      const fresh = await api.document(key, slug);
      setKept({ title, content });
      setTitle(fresh.document.title);
      setContent(fresh.content);
      setBase(fresh.document.version);
      setConflict(false);
      update.reset();
    } catch (failure) {
      setFreshError(failure);
    } finally {
      setLoadingFresh(false);
    }
  };

  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {gone ? (
        <p className={styles.bar} role="alert">
          {t('documents.gone')}
        </p>
      ) : null}
      {conflict ? (
        <div className={styles.bar} role="alert">
          <strong>{t('documents.conflict.title')}</strong>
          <span>{t('documents.conflict.body')}</span>
          <span className={styles.barActions}>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void copy(content, t('documents.conflict.copied'))}
            >
              {t('documents.conflict.copy')}
            </Button>
            <Button type="button" size="sm" variant="primary" loading={loadingFresh} onClick={loadFresh}>
              {t('documents.conflict.reload')}
            </Button>
          </span>
        </div>
      ) : stale ? (
        <div className={styles.bar} role="status">
          <span>{t('documents.liveUpdated')}</span>
          <span className={styles.barActions}>
            <Button type="button" size="sm" variant="secondary" loading={loadingFresh} onClick={loadFresh}>
              {t('documents.conflict.reload')}
            </Button>
          </span>
        </div>
      ) : null}
      {freshError ? <ErrorBanner>{errorMessage(freshError)}</ErrorBanner> : null}
      {kept ? (
        <section className={styles.kept} aria-label={t('documents.conflict.kept')}>
          <div className={styles.keptHead}>
            <strong>{t('documents.conflict.kept')}</strong>
            <span className={styles.barActions}>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void copy(kept.content, t('documents.conflict.copied'))}
              >
                {t('documents.conflict.keptCopy')}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setKept(null)}>
                {t('documents.conflict.keptDiscard')}
              </Button>
            </span>
          </div>
          <textarea
            className={styles.keptText}
            readOnly
            value={kept.content}
            aria-label={t('documents.conflict.kept')}
          />
        </section>
      ) : null}
      <TextField
        label={t('documents.editor.titleLabel')}
        hint={slug ? t('documents.editor.titleHintEdit') : t('documents.editor.titleHint')}
        value={title}
        maxLength={MAX_DOCUMENT_TITLE_LENGTH}
        required
        autoFocus
        disabled={saving}
        onChange={(event) => setTitle(event.target.value)}
      />
      <DescriptionEditor
        label={t('documents.editor.contentLabel')}
        value={content}
        onChange={setContent}
        disabled={saving}
      />
      <p className={styles.secrets}>
        <Icon name="lock" size={15} strokeWidth={2.2} />
        <span>{t('documents.editor.secretWarning')}</span>
      </p>
      <TextField
        label={t('documents.editor.messageLabel')}
        optional
        value={message}
        maxLength={200}
        disabled={saving}
        onChange={(event) => setMessage(event.target.value.replace(/[\r\n]+/g, ' '))}
      />
      {bytes > BYTES_SHOWN_FROM ? (
        <p className={styles.bytes} aria-live="polite">
          {t('documents.editor.bytes', {
            used: numberFormat().format(bytes),
            limit: numberFormat().format(MAX_DOCUMENT_BYTES),
          })}
        </p>
      ) : null}
      {showError ? <ErrorBanner>{errorMessage(error)}</ErrorBanner> : null}
      <div className={styles.actions}>
        <Button
          type="button"
          variant="secondary"
          size="md"
          onClick={() => (dirty ? setDiscardOpen(true) : onCancel())}
        >
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" size="md" loading={saving} disabled={gone || !title.trim()}>
          {slug ? t('documents.editor.save') : t('documents.editor.create')}
        </Button>
      </div>
      <Dialog
        open={discardOpen}
        onClose={() => setDiscardOpen(false)}
        title={t('documents.editor.discardTitle')}
        size="sm"
      >
        <p>{t('documents.editor.discardBody')}</p>
        <DialogActions>
          <Button type="button" variant="secondary" size="md" onClick={() => setDiscardOpen(false)}>
            {t('documents.editor.discardKeep')}
          </Button>
          <Button type="button" variant="dangerSolid" size="md" onClick={onCancel}>
            {t('documents.editor.discardConfirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </form>
  );
}

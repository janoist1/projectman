import { useId, useState } from 'react';
import type { FeedbackMarkDetail, Visibility } from '@projectman/shared';
import { useCreateTaskFromFeedback } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog, DialogActions } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TextAreaField, TextField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { titleFromBody } from './feedbackModel';
import styles from './FeedbackDialogs.module.css';

/** The card's description: the mark's words, then where it was made. The screenshot goes along as an attachment on the server. */
export function cardDescription(mark: FeedbackMarkDetail): string {
  const lines = [mark.body.trim(), ''];
  if (mark.pageTitle) lines.push(t('feedback.create.pageLine', { title: mark.pageTitle }));
  lines.push(t('feedback.create.linkLine', { url: mark.pageUrl }));
  lines.push(t('feedback.create.authorLine', { name: mark.author.name }));
  return lines.join('\n');
}

function CreateCardForm({
  mark,
  clientAuthor,
  onClose,
}: {
  mark: FeedbackMarkDetail;
  clientAuthor: boolean;
  onClose: () => void;
}) {
  const { key } = useProject();
  const toast = useToast();
  const create = useCreateTaskFromFeedback(key, mark.id);
  const formId = useId();
  const [title, setTitle] = useState(() => titleFromBody(mark.body));
  const [visibility, setVisibility] = useState<Visibility>(clientAuthor ? 'shared' : 'internal');
  const [reply, setReply] = useState('');
  const ready = title.trim() !== '';

  const submit = () => {
    if (!ready || create.isPending) return;
    create.mutate(
      {
        title: title.trim(),
        description: cardDescription(mark),
        visibility,
        ...(reply.trim() ? { reply: reply.trim() } : {}),
      },
      {
        onSuccess: ({ task }) => {
          toast.show(t('feedback.create.done', { key: task.key }), 'ok', {
            items: [{ key: task.key, text: task.title, to: `/p/${key}/tasks/${task.key}` }],
          });
          onClose();
        },
      },
    );
  };

  return (
    <form
      id={formId}
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className={styles.info}>{t('feedback.create.info')}</p>
      <TextField
        label={t('feedback.create.title')}
        value={title}
        maxLength={200}
        disabled={create.isPending}
        onChange={(event) => setTitle(event.target.value)}
        autoFocus
      />
      <fieldset className={styles.field}>
        <legend className={styles.label}>{t('feedback.create.visibility')}</legend>
        <div className={styles.choices}>
          {(['shared', 'internal'] as const).map((value) => (
            <label key={value} className={styles.choice}>
              <input
                type="radio"
                name={`${formId}-visibility`}
                checked={visibility === value}
                disabled={create.isPending}
                onChange={() => setVisibility(value)}
              />
              {t(`feedback.visibility.${value}`)}
            </label>
          ))}
        </div>
        {clientAuthor && visibility === 'shared' ? (
          <p className={styles.info}>{t('feedback.create.clientShared', { name: mark.author.name })}</p>
        ) : null}
        {clientAuthor && visibility === 'internal' ? (
          <p className={styles.warn}>{t('feedback.internalHidden', { name: mark.author.name })}</p>
        ) : null}
      </fieldset>
      <TextAreaField
        label={t('feedback.reply.label')}
        optional
        rows={3}
        value={reply}
        maxLength={4000}
        disabled={create.isPending}
        onChange={(event) => setReply(event.target.value)}
      />
      <DialogActions error={create.error ? <ErrorBanner>{errorMessage(create.error)}</ErrorBanner> : null}>
        <Button type="button" variant="secondary" size="md" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" form={formId} size="md" loading={create.isPending} disabled={!ready}>
          {t('feedback.create.submit')}
        </Button>
      </DialogActions>
    </form>
  );
}

/** "＋ Új kártya": a card from the mark, the visibility decided here (a client's mark starts shared). */
export function CreateCardDialog({
  open,
  mark,
  clientAuthor,
  onClose,
}: {
  open: boolean;
  mark: FeedbackMarkDetail;
  clientAuthor: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={t('feedback.create.heading')} size="md">
      {open ? <CreateCardForm mark={mark} clientAuthor={clientAuthor} onClose={onClose} /> : null}
    </Dialog>
  );
}

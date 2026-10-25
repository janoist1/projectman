import { useId, useState } from 'react';
import type { FeedbackMarkDetail } from '@projectman/shared';
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

function CreateCardForm({ mark, onClose }: { mark: FeedbackMarkDetail; onClose: () => void }) {
  const { key } = useProject();
  const toast = useToast();
  const create = useCreateTaskFromFeedback(key, mark.id);
  const formId = useId();
  const [title, setTitle] = useState(() => titleFromBody(mark.body));
  const [reply, setReply] = useState('');
  const ready = title.trim() !== '';

  const submit = () => {
    if (!ready || create.isPending) return;
    create.mutate(
      {
        title: title.trim(),
        description: cardDescription(mark),
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
        <Button
          type="submit"
          form={formId}
          variant="primary"
          size="md"
          loading={create.isPending}
          disabled={!ready}
        >
          {t('feedback.create.submit')}
        </Button>
      </DialogActions>
    </form>
  );
}

/** Create a card from the mark. */
export function CreateCardDialog({
  open,
  mark,
  onClose,
}: {
  open: boolean;
  mark: FeedbackMarkDetail;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={t('feedback.create.heading')} size="md">
      {open ? <CreateCardForm mark={mark} onClose={onClose} /> : null}
    </Dialog>
  );
}

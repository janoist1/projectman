import { useId, useState } from 'react';
import { useBoard, useRoles, useSendTeamMessage } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { DialogActions } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { SelectField, TextAreaField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { whenToAsk } from '../../lib/roles';
import styles from './MessageComposer.module.css';

export function MessageComposer({
  initialTo = [],
  initialTask = '',
  onSent,
  onCancel,
}: {
  initialTo?: string[];
  initialTask?: string;
  onSent?: () => void;
  /** In a dialog: the Cancel button next to Send. */
  onCancel?: () => void;
}) {
  const formId = useId();
  const { key, myHandle, me } = useProject();
  const board = useBoard(key);
  const roles = useRoles(key);
  const send = useSendTeamMessage(key);
  const toast = useToast();
  const [to, setTo] = useState(initialTo);
  const [text, setText] = useState('');
  const [taskKey, setTaskKey] = useState(initialTask);
  const recipients = (board.data?.members ?? []).filter(
    (m) => m.handle !== myHandle && m.status !== 'retired',
  );
  const selected = to.filter((handle) => recipients.some((m) => m.handle === handle));
  const access = me.projects.find((p) => p.key === key)?.access;
  if (!access || !['owner', 'admin', 'developer', 'client'].includes(access)) return null;
  return (
    <form
      id={formId}
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!selected.length || !text.trim()) return;
        send.mutate(
          { to: selected, text: text.trim(), ...(taskKey ? { taskKey } : {}) },
          {
            onSuccess: () => {
              setText('');
              toast.show(t('messages.sent'));
              onSent?.();
            },
          },
        );
      }}
    >
      <fieldset className={styles.recipients} disabled={send.isPending}>
        <legend>{t('messages.recipients')}</legend>
        {recipients.map((member) => {
          const ask = whenToAsk(member.roles, roles.data?.roles);
          return (
            <label key={member.handle} className={styles.recipient}>
              <input
                type="checkbox"
                checked={to.includes(member.handle)}
                onChange={(event) =>
                  setTo(event.target.checked ? [...to, member.handle] : to.filter((h) => h !== member.handle))
                }
              />
              <Avatar member={member} size="sm" />
              <span>
                {member.displayName} <small>{member.handle}</small>
                {ask ? (
                  <small className={styles.whenToAsk}>
                    {t('roleCatalogue.whenToAsk')}: {ask}
                  </small>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      <SelectField
        label={t('messages.task')}
        optional
        value={taskKey}
        onChange={(event) => setTaskKey(event.target.value)}
      >
        <option value="">{t('messages.noTask')}</option>
        {(board.data?.tasks ?? []).map((task) => (
          <option key={task.key} value={task.key}>
            {task.key} · {task.title}
          </option>
        ))}
      </SelectField>
      <TextAreaField
        label={t('messages.text')}
        required
        maxLength={20000}
        rows={4}
        value={text}
        disabled={send.isPending}
        onChange={(event) => setText(event.target.value)}
      />
      <DialogActions error={send.error ? <ErrorBanner>{errorMessage(send.error)}</ErrorBanner> : null}>
        {onCancel ? (
          <Button variant="secondary" size="md" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        ) : null}
        <Button
          type="submit"
          form={formId}
          variant="primary"
          size="md"
          loading={send.isPending}
          disabled={!selected.length || !text.trim()}
        >
          {t('messages.send')}
        </Button>
      </DialogActions>
    </form>
  );
}

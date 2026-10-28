import { useId, useRef, useState } from 'react';
import { useBoard, useRoles } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { DialogActions } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { SelectField, TextAreaField } from '../../components/Field';
import { LeaveChip } from '../../components/LeaveChip';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { whenToAsk } from '../../lib/roles';
import { PauseNote } from '../pause/PauseNote';
import { useTeamPaused } from '../pause/usePause';
import styles from './MessageComposer.module.css';
import { useContacts } from './useContacts';
import { useMessageAttachmentUploads } from './useMessageAttachmentUploads';
import { useCardBusySend } from './useCardBusySend';
import { MessageAttachmentTray } from './MessageAttachmentTray';
import { useFileDrop } from '../board/useFileDrop';
import { pasteHasText, pastedImages } from '../../lib/attachmentInput';
import { useIsMobile } from '../../lib/hooks';
import attachmentStyles from './MessageAttachments.module.css';

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
  const {
    mutation: send,
    send: sendConfirmed,
    dialog: cardBusyDialog,
  } = useCardBusySend(key, () => input.current);
  const uploads = useMessageAttachmentUploads(key);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const isMobile = useIsMobile();
  const fileDrop = useFileDrop({
    allowed: !send.isPending && !isMobile,
    onFiles: uploads.add,
    isolate: true,
  });
  const teamPaused = useTeamPaused();
  const toast = useToast();
  const contacts = useContacts();
  const [chosen, setChosen] = useState<string[] | null>(initialTo.length ? initialTo : null);
  const [text, setText] = useState('');
  const [taskKey, setTaskKey] = useState(initialTask);
  // A member who writes only to the contacts sees only them (PM-985).
  const recipients = (board.data?.members ?? []).filter(
    (m) => m.handle !== myHandle && m.status !== 'retired' && contacts.canWriteTo(m.handle),
  );
  // A single possible recipient is chosen for them until they choose themselves.
  const to = chosen ?? (contacts.restricted && recipients.length === 1 ? [recipients[0]!.handle] : []);
  const selected = to.filter((handle) => recipients.some((m) => m.handle === handle));
  const access = me.projects.find((p) => p.key === key)?.access;
  if (!access || !['owner', 'admin', 'developer', 'client'].includes(access)) return null;
  // Nobody to write to: the page says so instead of offering a form that cannot send.
  if (contacts.restricted && contacts.ready && recipients.length === 0) return null;
  return (
    <form
      id={formId}
      className={styles.form}
      data-message-composer
      {...fileDrop.props}
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !selected.length ||
          (!text.trim() && !uploads.items.length) ||
          uploads.blockedReason ||
          send.isPending
        )
          return;
        // A failure shows under the form (`send.error`); stepping back from the busy-card warning shows nothing.
        sendConfirmed({
          to: selected,
          text: text.trim(),
          ...(uploads.items.length
            ? {
                attachmentIds: uploads.items.flatMap((item) => (item.attachment ? [item.attachment.id] : [])),
              }
            : {}),
          ...(taskKey ? { taskKey } : {}),
        }).then(
          () => {
            setText('');
            uploads.clear();
            toast.show(t('messages.sent'));
            onSent?.();
          },
          () => undefined,
        );
      }}
    >
      {fileDrop.state && !isMobile ? (
        <div className={attachmentStyles.drop} role="status">
          {t('attachments.dropActive')}
        </div>
      ) : null}
      <fieldset className={styles.recipients} disabled={send.isPending}>
        <legend>{t('messages.recipients')}</legend>
        {contacts.restricted ? <small>{t('messages.contactsOnlyHint')}</small> : null}
        {recipients.map((member) => {
          const ask = whenToAsk(member.roles, roles.data?.roles);
          return (
            <label key={member.handle} className={styles.recipient}>
              <input
                type="checkbox"
                checked={to.includes(member.handle)}
                onChange={(event) =>
                  setChosen(
                    event.target.checked ? [...to, member.handle] : to.filter((h) => h !== member.handle),
                  )
                }
              />
              <Avatar member={member} size="sm" />
              <span>
                {member.displayName} <LeaveChip member={member} /> <small>{member.handle}</small>
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
        ref={input}
        onPaste={(event) => {
          if (pasteHasText(event.clipboardData)) return;
          const images = pastedImages(event.clipboardData);
          if (!images.length) return;
          event.preventDefault();
          event.stopPropagation();
          if (!send.isPending) uploads.add(images);
        }}
        maxLength={20000}
        rows={4}
        value={text}
        disabled={send.isPending}
        onChange={(event) => setText(event.target.value)}
      />
      <input
        type="file"
        multiple
        hidden
        ref={picker}
        aria-label={t('messageAttachments.add')}
        onChange={(event) => {
          if (!send.isPending) uploads.add(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon="paperclip"
        className={styles.attach}
        disabled={send.isPending}
        title={t('messageAttachments.addTitle')}
        onClick={() => picker.current?.click()}
      >
        {t('messageAttachments.add')}
      </Button>
      <MessageAttachmentTray
        items={uploads.items}
        onRemove={uploads.remove}
        onRetry={uploads.retry}
        focusInput={() => input.current?.focus()}
        disabled={send.isPending}
      />
      <span className={styles.hint} aria-live="polite">
        {uploads.error ? (
          <span role="alert">{uploads.error}</span>
        ) : (
          (uploads.blockedReason ?? t('messageAttachments.hintForm'))
        )}
      </span>
      {teamPaused && selected.some((handle) => recipients.find((m) => m.handle === handle)?.kind === 'ai') ? (
        <PauseNote>{t('session.composer.pausedLive')}</PauseNote>
      ) : null}
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
          disabled={
            !selected.length || (!text.trim() && !uploads.items.length) || Boolean(uploads.blockedReason)
          }
        >
          {t('messages.send')}
        </Button>
      </DialogActions>
      {cardBusyDialog}
    </form>
  );
}

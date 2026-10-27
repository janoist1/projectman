import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { MemberHandle } from '@projectman/shared';
import type { MemberView } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useEmailChannel, useRenameMember } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TextField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import styles from './RenameMemberDialog.module.css';

function RenameForm({
  member,
  busyWith,
  onClose,
}: {
  member: MemberView;
  /** What the member works on right now, when that is known (the profile); null: nothing known. */
  busyWith: string | null;
  onClose: () => void;
}) {
  const { key } = useProject();
  const rename = useRenameMember(key);
  const channel = useEmailChannel(key);
  const toast = useToast();
  const navigate = useNavigate();
  const formId = useId();
  const noteId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(member.handle);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    input.current?.select();
  }, []);

  const emailOn = channel.data?.senders.some((sender) => sender.handle === member.handle) === true;
  const domain = channel.data?.memberDomain ?? null;
  const typed = MemberHandle.safeParse(value.trim().toLowerCase());
  const pending = rename.isPending;
  const busy = busyWith !== null;

  const fail = (message: string): void => {
    setFieldError(message);
    input.current?.focus();
  };
  const submit = (): void => {
    if (busy || pending) return;
    const handle = value.trim().toLowerCase();
    if (!MemberHandle.safeParse(handle).success) return fail(t('memberRename.invalid'));
    if (handle === member.handle) return fail(t('memberRename.unchanged'));
    setBanner(null);
    rename.mutate(
      { handle: member.handle, body: { handle } },
      {
        onSuccess: (renamed) => {
          toast.show(t('memberRename.done', { from: member.handle, to: renamed.handle }));
          onClose();
          void navigate(`/p/${key}/team/${renamed.handle}`, { replace: true });
        },
        onError: (cause) => {
          if (isApiError(cause) && cause.code === 'handle_taken') fail(t('memberRename.taken', { handle }));
          else if (isApiError(cause) && cause.code === 'email_mailbox_taken')
            fail(t('memberRename.mailboxTaken'));
          else setBanner(errorMessage(cause));
        },
      },
    );
  };

  return (
    <Dialog
      open
      // Nothing closes the dialog while the rename is on its way.
      onClose={pending ? () => undefined : onClose}
      closeOnBackdrop={!pending}
      title={t('memberRename.title', { name: member.displayName })}
      size="sm"
      error={banner ? <ErrorBanner>{banner}</ErrorBanner> : null}
      footer={
        <>
          <Button variant="secondary" size="md" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            size="md"
            loading={pending}
            // Focusable though refused, so the reason below is read with it.
            aria-disabled={busy || undefined}
            aria-describedby={busy ? noteId : undefined}
          >
            {pending ? t('memberRename.submitting') : t('memberRename.submit')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className={styles.body}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className={styles.text}>{t('memberRename.intro')}</p>
        <TextField
          ref={input}
          label={t('memberRename.label')}
          hint={t('memberRename.hint', { handle: member.handle })}
          error={fieldError ?? undefined}
          className={styles.input}
          value={value}
          readOnly={pending}
          maxLength={32}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            setValue(event.target.value);
            setFieldError(null);
          }}
        />
        <section className={styles.consequences}>
          <h3 className={styles.consequencesTitle}>{t('memberRename.consequencesTitle')}</h3>
          <ul>
            <li>{t('memberRename.carriesOn')}</li>
            <li>{t('memberRename.oldHandleReserved', { handle: member.handle })}</li>
            {emailOn ? (
              <li>
                {domain !== null
                  ? t('memberRename.emailFollows', {
                      address: `${typed.success ? typed.data : t('memberRename.newHandle')}@${domain}`,
                    })
                  : t('memberRename.emailFollowsNoDomain')}
              </li>
            ) : null}
            <li>{t('memberRename.notWhileWorking')}</li>
          </ul>
        </section>
        {busy ? (
          <p id={noteId} role="status" className={styles.working}>
            {t('memberRename.working', { work: busyWith })}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Renames an AI member's handle (PM-1026): the owner confirms its consequences in the same dialog. */
export function RenameMemberDialog({
  member,
  busyWith = null,
  onClose,
}: {
  member: MemberView | null;
  busyWith?: string | null;
  onClose: () => void;
}) {
  return member ? <RenameForm member={member} busyWith={busyWith} onClose={onClose} /> : null;
}

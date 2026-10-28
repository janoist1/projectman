import { useRef, useState } from 'react';
import type { CreatedOwnerInvitation } from '@projectman/shared';
import { useCreateOwnerInvitation } from '../../../api/queries';
import { Button } from '../../../components/Button';
import { CopyRow } from '../../../components/CopyRow';
import { Dialog } from '../../../components/Dialog';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { TextField } from '../../../components/Field';
import { formatDate } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';

export function InviteOwnerDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateOwnerInvitation();
  const [email, setEmail] = useState('');
  const [created, setCreated] = useState<CreatedOwnerInvitation | null>(null);
  const form = useRef<HTMLFormElement>(null);
  return (
    <Dialog
      open
      size="sm"
      closeOnBackdrop={false}
      title={t(created ? 'owners.created' : 'owners.invite')}
      description={created ? undefined : t('owners.inviteIntro')}
      onClose={() => {
        if (!create.isPending) onClose();
      }}
      error={create.isError ? <ErrorBanner>{errorMessage(create.error)}</ErrorBanner> : undefined}
      footer={
        created ? (
          <Button size="md" variant="primary" onClick={onClose}>
            {t('owners.done')}
          </Button>
        ) : (
          <>
            <Button size="md" disabled={create.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              size="md"
              variant="primary"
              loading={create.isPending}
              disabled={!email.trim()}
              onClick={() => form.current?.requestSubmit()}
            >
              {t('owners.create')}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <>
          <CopyRow
            text={new URL(created.path, window.location.origin).href}
            label={t('owners.link')}
            failedText={t('owners.copyFailed')}
          />
          <p>{t('owners.linkHint', { expires: formatDate(created.expiresAt) })}</p>
        </>
      ) : (
        <form
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            if (!create.isPending) create.mutate({ body: { email: email.trim() }, onCreated: setCreated });
          }}
        >
          <TextField
            autoFocus
            required
            type="email"
            label={t('owners.email')}
            value={email}
            disabled={create.isPending}
            onChange={(event) => setEmail(event.target.value)}
          />
        </form>
      )}
    </Dialog>
  );
}

import { useState } from 'react';
import type { MemberView } from '@projectman/shared';
import { useRetireMember, useRoles } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { ChoiceCard } from '../../components/Field';
import { Dialog } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LeaveChip } from '../../components/LeaveChip';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { roleLabel } from '../../lib/members';
import styles from './RetireDialog.module.css';

interface RetireDialogProps {
  member: MemberView | null;
  candidates: readonly MemberView[];
  onClose: () => void;
}

function RetireForm({
  member,
  candidates,
  onClose,
}: {
  member: MemberView;
  candidates: readonly MemberView[];
  onClose: () => void;
}) {
  const { key } = useProject();
  const roles = useRoles(key);
  const retire = useRetireMember(key);
  const toast = useToast();
  const sameRole = candidates.filter((candidate) => candidate.role === member.role);
  const others = candidates.filter((candidate) => candidate.role !== member.role);
  const ordered = [...sameRole, ...others];
  const [target, setTarget] = useState<string>(sameRole[0]?.handle ?? '');

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('retire.title', { name: member.displayName })}
      size="sm"
      error={retire.isError ? <ErrorBanner>{errorMessage(retire.error)}</ErrorBanner> : null}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="dangerSolid"
            size="md"
            loading={retire.isPending}
            onClick={() =>
              retire.mutate(
                { handle: member.handle, body: target ? { handoverTo: target } : {} },
                {
                  onSuccess: () => {
                    toast.show(t('retire.done', { name: member.displayName }));
                    onClose();
                  },
                },
              )
            }
          >
            {retire.isPending ? t('retire.submitting') : t('retire.submit')}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <p className={styles.text}>{t('retire.body')}</p>
        <fieldset className={styles.fieldset}>
          <legend className="visually-hidden">{t('retire.handoverLabel')}</legend>
          {ordered.map((candidate) => (
            <ChoiceCard
              key={candidate.handle}
              name="handover"
              value={candidate.handle}
              checked={target === candidate.handle}
              onChange={setTarget}
              title={
                <>
                  {`${candidate.displayName} · ${candidate.handle}`}
                  <LeaveChip member={candidate} />
                </>
              }
              description={roleLabel(candidate, roles.data?.roles)}
              leading={<Avatar member={candidate} size="md" />}
            />
          ))}
          <ChoiceCard
            name="handover"
            value=""
            checked={target === ''}
            onChange={setTarget}
            title={t('retire.nobody')}
          />
        </fieldset>
      </div>
    </Dialog>
  );
}

/** Retire an AI member; their stages and running work move to the chosen member. */
export function RetireDialog({ member, candidates, onClose }: RetireDialogProps) {
  return member ? <RetireForm member={member} candidates={candidates} onClose={onClose} /> : null;
}

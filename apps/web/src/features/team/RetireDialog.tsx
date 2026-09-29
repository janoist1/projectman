import { useState } from 'react';
import type { MemberView } from '@projectman/shared';
import { useRetireMember } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { ChoiceCard } from '../../components/Field';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { roleLabel } from '../../lib/members';
import styles from './RetireDialog.module.css';

interface RetireDialogProps {
  member: MemberView | null;
  candidates: readonly MemberView[];
  onClose: () => void;
}

function RetireForm({ member, candidates, onDone }: { member: MemberView; candidates: readonly MemberView[]; onDone: () => void }) {
  const { key } = useProject();
  const retire = useRetireMember(key);
  const toast = useToast();
  const sameRole = candidates.filter((candidate) => candidate.role === member.role);
  const others = candidates.filter((candidate) => candidate.role !== member.role);
  const ordered = [...sameRole, ...others];
  const [target, setTarget] = useState<string>(sameRole[0]?.handle ?? '');

  return (
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
            title={`${candidate.displayName} · ${candidate.handle}`}
            description={roleLabel(candidate)}
            leading={<Avatar member={candidate} size="md" />}
          />
        ))}
        <ChoiceCard name="handover" value="" checked={target === ''} onChange={setTarget} title={t('retire.nobody')} />
      </fieldset>
      {retire.isError ? (
        <p className={styles.error} role="alert">
          {errorMessage(retire.error)}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          variant="dangerSolid"
          size="lg"
          loading={retire.isPending}
          onClick={() =>
            retire.mutate(
              { handle: member.handle, body: target ? { handoverTo: target } : {} },
              {
                onSuccess: () => {
                  toast.show(t('retire.done', { name: member.displayName }));
                  onDone();
                },
              },
            )
          }
        >
          {retire.isPending ? t('retire.submitting') : t('retire.submit')}
        </Button>
        <Button variant="secondary" size="lg" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** Retire an AI member; their stages and running work move to the chosen member. */
export function RetireDialog({ member, candidates, onClose }: RetireDialogProps) {
  return (
    <Dialog open={member !== null} onClose={onClose} title={member ? t('retire.title', { name: member.displayName }) : ''} size="sm">
      {member ? <RetireForm member={member} candidates={candidates} onDone={onClose} /> : null}
    </Dialog>
  );
}

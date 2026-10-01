import type { MemberView } from '@projectman/shared';
import { useUpdateMember } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import type { ButtonSize } from '../../components/Button';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';

/** Sends an AI member on leave, or calls it back (decision 23). */
export function LeaveButton({ member, size }: { member: MemberView; size?: ButtonSize }) {
  const { key } = useProject();
  const update = useUpdateMember(key);
  const toast = useToast();
  const onLeave = member.onLeave === true;
  return (
    <Button
      variant="ghost"
      size={size}
      loading={update.isPending}
      aria-label={t(onLeave ? 'leave.callBackMember' : 'leave.sendMember', { name: member.displayName })}
      onClick={() =>
        update.mutate(
          { handle: member.handle, body: { onLeave: !onLeave } },
          {
            onSuccess: () =>
              toast.show(t(onLeave ? 'leave.calledBack' : 'leave.sent', { name: member.displayName })),
            onError: (error) => toast.show(errorMessage(error), 'error'),
          },
        )
      }
    >
      {t(onLeave ? 'leave.callBack' : 'leave.send')}
    </Button>
  );
}

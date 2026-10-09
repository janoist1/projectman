import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { ProjectManagerChannel } from '@projectman/shared';
import { useUpdateMember } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { useToast } from '../../components/toastContext';
import { formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { startWaitingText } from '../../lib/taskState';
import { pmWaitOf } from './pmChannel';
import styles from './PmWaitBanner.module.css';

/** The line above the composer that says why the project manager cannot answer right now (PM-429). */
export function PmWaitBanner({ channel }: { channel: ProjectManagerChannel }) {
  const { key, can, myHandle, openPauseDetails, closePm } = useProject();
  const { members } = useProjectIndexes(key);
  const toast = useToast();
  const update = useUpdateMember(key);
  const handle = channel.member?.handle ?? '';
  const name = channel.member?.displayName ?? t('pm.name');
  const wait = pmWaitOf(channel);

  const callBack = () =>
    update.mutate(
      { handle, body: { onLeave: false } },
      {
        onSuccess: () => toast.show(t('leave.calledBack', { name })),
        onError: (error) => toast.show(errorMessage(error), 'error'),
      },
    );
  // The panel does not cover the pause bar's details, where the team is resumed.
  const resumeTeam = () => {
    closePm();
    openPauseDetails();
  };

  if (wait === 'leave') {
    return (
      <Banner
        tone="needs"
        title={t('pm.banner.onLeave')}
        text={can.manageTeam ? t('pm.banner.onLeaveText') : t('pm.banner.onLeaveOther')}
        action={
          can.manageTeam ? (
            <Button variant="secondary" size="sm" loading={update.isPending} onClick={callBack}>
              {t('pm.banner.callBack')}
            </Button>
          ) : null
        }
      />
    );
  }
  if (wait === 'paused') {
    return (
      <Banner
        text={t('pm.banner.paused')}
        action={
          can.pauseTeam ? (
            <Button variant="secondary" size="sm" onClick={resumeTeam}>
              {t('pm.banner.resume')}
            </Button>
          ) : null
        }
      />
    );
  }
  if (wait === 'quota') {
    const until = channel.waiting?.until;
    return (
      <Banner
        text={until ? t('pm.banner.quota', { until: formatTime(until) }) : t('pm.banner.quotaUnknown')}
      />
    );
  }
  if (channel.state === 'starting') return <Banner text={t('pm.banner.starting')} />;
  if (wait === 'queued' && channel.waiting) {
    const reason = startWaitingText(channel.waiting, { members, myHandle });
    return <Banner text={t('pm.banner.waiting', { reason })} />;
  }
  if (channel.state === 'working') return <Banner text={t('pm.banner.working')} working />;
  return null;
}

function Banner({
  title,
  text,
  action,
  working = false,
  tone,
}: {
  title?: string;
  text: string;
  action?: ReactNode;
  working?: boolean;
  /** `needs`: the owner can do something about it. */
  tone?: 'needs';
}) {
  return (
    <div className={clsx(styles.banner, tone === 'needs' && styles.needs)} role="status">
      {working ? (
        <span className={styles.dots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : null}
      <span className={styles.text}>
        {title ? <b className={styles.title}>{title}</b> : null}
        {text}
      </span>
      {action}
    </div>
  );
}

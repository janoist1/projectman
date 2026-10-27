import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ProjectManagerChannel } from '@projectman/shared';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { startWaitingText } from '../../lib/taskState';
import { operatorWaitOf } from './operatorChannel';
import styles from './OperatorWaitBanner.module.css';

/** The line above the composer that says why the project manager cannot answer right now (PM-429, PM-447, PM-1042). */
export function OperatorWaitBanner({ channel }: { channel: ProjectManagerChannel }) {
  const { key, can, isOwner, myHandle, openPauseDetails, closeOperator } = useProject();
  const { members } = useProjectIndexes(key);
  const wait = operatorWaitOf(channel);

  // A message to someone on leave is kept and answered when they are back, so writing stays open (PM-1042).
  if (channel.state === 'on_leave')
    return (
      <Banner
        text={t('operator.banner.onLeave')}
        action={
          isOwner && channel.member ? (
            <Link
              to={`/p/${key}/team/${channel.member.handle}`}
              className={styles.link}
              onClick={closeOperator}
            >
              {t('operator.banner.profile')} →
            </Link>
          ) : null
        }
      />
    );

  // The panel does not cover the pause bar's details, where the team is resumed.
  const resumeTeam = () => {
    closeOperator();
    openPauseDetails();
  };

  if (wait === 'paused') {
    return (
      <Banner
        text={t('operator.banner.paused')}
        action={
          can.pauseTeam ? (
            <Button variant="secondary" size="sm" onClick={resumeTeam}>
              {t('operator.banner.resume')}
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
        text={
          until ? t('operator.banner.quota', { until: formatTime(until) }) : t('operator.banner.quotaUnknown')
        }
      />
    );
  }
  if (channel.state === 'starting') return <Banner text={t('operator.banner.starting')} />;
  if (wait === 'queued' && channel.waiting) {
    const reason = startWaitingText(channel.waiting, { members, myHandle });
    return <Banner text={t('operator.banner.waiting', { reason })} />;
  }
  if (channel.state === 'working') return <Banner text={t('operator.banner.working')} working />;
  return null;
}

function Banner({ text, action, working = false }: { text: string; action?: ReactNode; working?: boolean }) {
  return (
    <div className={styles.banner} role="status">
      {working ? (
        <span className={styles.dots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : null}
      <span className={styles.text}>{text}</span>
      {action}
    </div>
  );
}

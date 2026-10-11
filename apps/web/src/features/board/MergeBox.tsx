import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { ProjectConfig, Task, TaskMergeState } from '@projectman/shared';
import { useStartMerge } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Fold } from '../../components/Fold';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/States';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import {
  failureKind,
  isMerger,
  mergeBlockText,
  mergeCheckCommand,
  mergeCommitOf,
  mergeRepo,
  mergeRequestedText,
  mergeTargetName,
  mergerName,
} from '../../lib/merge';
import type { MemberIndex } from '../../lib/members';
import { nameOf } from '../../lib/members';
import { shortCommit } from '../../lib/timeline';
import styles from './SignalBox.module.css';
import box from './MergeBox.module.css';

interface MergeBoxProps {
  task: Task;
  members: MemberIndex;
  myHandle: string | null;
  config?: ProjectConfig;
  /** The viewer has the merge's inbox item, which is shown in place of a requested merge's box. */
  asked?: boolean;
  /** "Vissza a fejlesztőnek": the drawer opens the move panel at the work stage. */
  onSendBack?: () => void;
}

type StepState = 'done' | 'active' | 'todo' | 'failed';

/** Which of the merge's steps are done, running or still to come, from the step the server reports. */
function runningSteps(merge: TaskMergeState, check: string | null, hasPush: boolean) {
  const command = check ?? merge.check?.command ?? null;
  const order = ['queued', 'merging', 'checking', 'pushing', 'finishing'] as const;
  const at = order.indexOf(merge.step ?? 'queued');
  const state = (own: number): StepState => (at > own ? 'done' : at === own ? 'active' : 'todo');
  const commit = merge.commit ? shortCommit(merge.commit) : merge.branch || '…';
  return [
    { id: 'merge', state: state(1), text: t('task.merge.running.merge', { commit, base: merge.base }) },
    // The row also shows when the step is the check but its command is not known (the header says it runs).
    ...(command || merge.check || merge.step === 'checking'
      ? [
          {
            id: 'check',
            state: state(2),
            text: command
              ? t('task.merge.running.check', { check: command })
              : t('task.merge.running.checkUnknown'),
          },
        ]
      : []),
    ...(hasPush ? [{ id: 'push', state: state(3), text: t('task.merge.running.push') }] : []),
  ];
}

function StepList({ steps }: { steps: { id: string; state: StepState; text: string }[] }) {
  return (
    <ul className={box.steps}>
      {steps.map((step) => (
        <li key={step.id} className={box.step} data-state={step.state}>
          <span className={box.mark} aria-hidden="true">
            {step.state === 'done' ? (
              <Icon name="check" size={13} strokeWidth={3} />
            ) : step.state === 'failed' ? (
              <Icon name="close" size={13} strokeWidth={3} />
            ) : step.state === 'active' ? (
              <Spinner size={12} />
            ) : (
              '·'
            )}
          </span>
          <span>{step.text}</span>
          <span className="visually-hidden"> ({t(`task.merge.running.${step.state}`)})</span>
        </li>
      ))}
    </ul>
  );
}

/** The reasons whose stop leaves the work merged and checked, with the push still to do. */
const PUSH_REASONS = new Set(['push_rejected', 'remote_unreachable', 'remote_moved', 'base_out_of_sync']);

/**
 * The merge of the card's approved work into the main branch, at the top of the drawer (PM-453): what to
 * do when the viewer merges, what runs, why it failed or stopped, and what the others wait for. The
 * viewer who is the merger sees the buttons; for everyone else it says who acts and when.
 */
export function MergeBox({ task, members, myHandle, config, asked = false, onSendBack }: MergeBoxProps) {
  const { key } = useProject();
  const start = useStartMerge(key);
  const merge = task.merge;
  // The request is shown by its inbox item; a failed or stopped merge is shown here, with its steps and buttons.
  if (!merge || (asked && merge.state === 'requested')) return null;
  const you = isMerger(merge, myHandle);
  const repo = mergeRepo(config, merge.repo);
  const github = repo ? !!repo.github : true;
  const check = mergeCheckCommand(config, merge);
  const target = mergeTargetName(config, merge);
  const commit = mergeCommitOf(task);
  const who = mergerName(merge, members, myHandle);
  const id = `merge-${task.key}`;
  const failure = start.isError ? (
    <p role="alert" className={styles.error}>
      {errorMessage(start.error)}
    </p>
  ) : null;
  const begin = (label: string, busy: string, variant: 'primary' | 'secondary' = 'primary') => (
    <Button
      variant={variant}
      size="md"
      className={box.action}
      loading={start.isPending}
      onClick={() => start.mutate(task.key)}
    >
      {start.isPending ? busy : label}
    </Button>
  );
  const frame = (title: string, tone: 'needs' | 'accent' | 'blocked', body: ReactNode, live = false) => (
    <section
      className={clsx(styles.box, tone === 'accent' && styles.accent, tone === 'blocked' && box.blocked)}
      aria-labelledby={id}
      aria-live={live ? 'polite' : undefined}
      data-testid="merge-box"
      data-merge-state={merge.state}
    >
      <div className={styles.head}>
        <Icon name="branch" size={14} strokeWidth={2.4} />
        <h3 id={id} className={styles.title}>
          {title}
        </h3>
      </div>
      {body}
    </section>
  );

  switch (merge.state) {
    case 'requested': {
      if (!you) return null;
      // The push clause is dropped for a repository with no remote.
      const text = mergeRequestedText({
        commit: commit ? shortCommit(commit) : null,
        base: merge.base,
        check,
        push: !!repo?.github,
      });
      return frame(
        t('task.merge.requested.title'),
        'needs',
        <>
          <p className={styles.text}>{text}</p>
          {failure}
          <div className={box.actions}>{begin(t('task.merge.button'), t('task.merge.starting'))}</div>
        </>,
      );
    }
    case 'queued':
      return frame(
        t('task.merge.queued.title'),
        'accent',
        <p className={styles.text}>{t('task.merge.queued.text')}</p>,
      );
    case 'running': {
      const started =
        merge.startedBy && merge.startedBy === myHandle
          ? t('task.merge.running.you')
          : merge.startedBy
            ? t('task.merge.running.by', { who: nameOf(merge.startedBy, members, myHandle) })
            : null;
      return frame(
        t('task.merge.running.title', { base: merge.base }),
        'accent',
        <>
          <StepList steps={runningSteps(merge, check, !!repo?.github || merge.step === 'pushing')} />
          {started ? <p className={styles.text}>{started}</p> : null}
        </>,
        true,
      );
    }
    case 'failed': {
      const conflict = failureKind(merge) === 'conflict';
      const files = merge.failure?.files ?? [];
      const tail = merge.failure?.outputTail;
      return frame(
        t(conflict ? 'task.merge.failed.conflictTitle' : 'task.merge.failed.checkTitle'),
        'blocked',
        <>
          <p className={styles.text}>{t('task.merge.failed.unchanged', { base: merge.base })}</p>
          {conflict && files.length > 0 ? (
            <Fold summary={t('task.merge.failed.files', { count: files.length })}>
              <pre className={box.output}>{files.join('\n')}</pre>
            </Fold>
          ) : null}
          {!conflict && tail ? (
            <Fold summary={t('task.merge.failed.output')}>
              <pre className={box.output}>{tail}</pre>
            </Fold>
          ) : null}
          {you ? (
            <>
              <p className={styles.text}>{t('task.merge.failed.guidance')}</p>
              {failure}
              <div className={box.actions}>
                {begin(t('task.merge.again'), t('task.merge.starting'))}
                {onSendBack ? (
                  <Button variant="secondary" size="md" className={box.action} onClick={onSendBack}>
                    {t('task.merge.sendBack')}
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <p className={box.faint}>{t('task.merge.failed.others', { merger: who, base: merge.base })}</p>
          )}
        </>,
      );
    }
    case 'blocked': {
      const reason = merge.block?.reason;
      const landedRemote = merge.landed === 'remote';
      const steps: { id: string; state: StepState; text: string }[] =
        reason && (PUSH_REASONS.has(reason) || (reason === 'local_checkout' && landedRemote))
          ? [
              { id: 'merge', state: 'done', text: t('task.merge.blocked.stepMerge') },
              {
                id: 'push',
                state: landedRemote ? 'done' : 'failed',
                text: t('task.merge.blocked.stepPush'),
              },
            ]
          : [];
      const detail = merge.block?.detail;
      return frame(
        t('task.merge.blocked.title'),
        'blocked',
        <>
          <p className={styles.text}>{mergeBlockText(merge, { github, check, target })}</p>
          {steps.length > 0 ? <StepList steps={steps} /> : null}
          <p className={styles.text}>
            {landedRemote
              ? t(github ? 'task.merge.blocked.remote' : 'task.merge.blocked.remoteOther')
              : t('task.merge.blocked.nowhere', { base: merge.base })}
          </p>
          {detail ? (
            <Fold summary={t('task.merge.details')}>
              <pre className={box.output}>{detail}</pre>
            </Fold>
          ) : null}
          {you ? (
            <>
              {failure}
              <div className={box.actions}>{begin(t('task.merge.retry'), t('task.merge.retrying'))}</div>
            </>
          ) : (
            <p className={box.faint}>{t('task.merge.blocked.others', { merger: who })}</p>
          )}
        </>,
      );
    }
  }
}

import { useId, useState } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router';
import { CARD_STEP_EVENT_TYPES, cardStepOutcome } from '@projectman/shared';
import type { CardStep, CardStepOutcome, Task, TaskStartWaiting, TimelineEvent } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { Chip } from '../../components/Chip';
import type { ChipTone } from '../../components/Chip';
import { formatAgo, formatStamp } from '../../i18n/format';
import { hasMessage, t, tDynamic } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import { startWaitingText } from '../../lib/taskState';
import type { TaskState } from '../../lib/taskState';
import { describeEvent } from '../../lib/timeline';
import type { TimelineContext } from '../../lib/timeline';
import { useCardLink } from './cardSize';
import { useDrawerBase } from './drawerBase';
import drawer from './drawer.module.css';
import styles from './TaskSteps.module.css';

/** The ran rows shown at first: the older ones open in place (PM-1151). */
const RAN_SHOWN = 10;

const OUTCOME_TONE: Record<CardStepOutcome, ChipTone> = {
  ran: 'ok',
  failed: 'blocked',
  handed_over: 'needs',
};
const STATE_TONE: Record<CardStep['state'], ChipTone> = {
  waiting: 'neutral',
  running: 'accent',
  reminded: 'needs',
  handed_over: 'needs',
};

/** The step's name, from the mechanism's own kind; an unknown kind reads "Lépés". */
function stepName(step: CardStep): string {
  const key =
    step.source === 'queue'
      ? `operator.queue.kinds.${step.kind}`
      : step.source === 'inbox'
        ? `inbox.kinds.${step.kind}`
        : step.source === 'start'
          ? 'task.steps.kinds.start'
          : `task.steps.kinds.obligation.${step.kind}`;
  return tDynamic(key, t('task.steps.kinds.other'));
}

/** What the step waits for, from its wait code; the code is data, so an unknown one reads "Vár". */
function waitText(step: CardStep, task: Task, ctx: Pick<TimelineContext, 'members' | 'myHandle' | 'labels'>) {
  if (!step.waitCode) return null;
  if (step.source === 'start') {
    const waiting = (task.startWaiting ?? {
      reason: step.waitCode,
      since: step.since,
    }) as TaskStartWaiting;
    return hasMessage(`taskStatus.startWaiting.${waiting.reason}`)
      ? startWaitingText(waiting, ctx)
      : t('task.steps.wait');
  }
  if (step.source === 'queue') {
    return tDynamic(`operator.queue.wait.${step.waitCode}`, t('operator.queue.wait.generic'));
  }
  if (step.source === 'obligation')
    return tDynamic(`task.steps.pause.${step.waitCode}`, t('task.steps.wait'));
  return null;
}

function Time({ value, className, children }: { value: string; className?: string; children?: string }) {
  return (
    <time dateTime={value} title={formatStamp(value)} className={className}>
      {children ?? formatStamp(value)}
    </time>
  );
}

function StepRow({
  step,
  task,
  ctx,
  now,
}: {
  step: CardStep;
  task: Task;
  ctx: TimelineContext;
  now: number;
}) {
  const cardLink = useCardLink();
  const drawerBase = useDrawerBase();
  const member = step.holder ? ctx.members.get(step.holder) : undefined;
  const mine = step.source === 'inbox' && step.holder !== null && step.holder === ctx.myHandle;
  const wait = waitText(step, task, ctx);
  const paused = step.source === 'obligation' && step.waitCode !== null;
  const overdue =
    step.dueAt !== null && step.state !== 'handed_over' && !paused && Date.parse(step.dueAt) < now;
  const body = (
    <>
      <span className={styles.stateDot} data-state={step.state} aria-hidden="true" />
      <span className={styles.stepBody}>
        <span className={styles.stepHead}>
          <span className={styles.stepName}>{stepName(step)}</span>
          <span className={styles.holder}>
            <Avatar member={member} handle={step.holder ?? undefined} isMe={mine} size="xs" />
            <span className={styles.holderName}>
              {step.holder ? nameOf(step.holder, ctx.members, ctx.myHandle) : t('task.steps.system')}
            </span>
          </span>
          {mine ? (
            <Chip tone="needs">{t('task.steps.forYou')}</Chip>
          ) : (
            <Chip tone={STATE_TONE[step.state]}>{t(`task.steps.state.${step.state}`)}</Chip>
          )}
        </span>
        {wait ? <span className={styles.stepWait}>{wait}</span> : null}
        <span className={styles.stepMeta}>
          <span>{t(`task.steps.source.${step.source}`)}</span>
          <span aria-hidden="true"> · </span>
          <Time value={step.since}>{t('task.steps.since', { time: formatStamp(step.since) })}</Time>
          {paused ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{t('task.steps.meta.duePaused')}</span>
            </>
          ) : step.dueAt ? (
            <>
              <span aria-hidden="true"> · </span>
              {overdue ? (
                <span className={styles.overdue} title={formatStamp(step.dueAt)}>
                  {t('task.steps.meta.overdue', { ago: formatAgo(step.dueAt) })}
                </span>
              ) : (
                <Time value={step.dueAt}>{t('task.steps.meta.due', { time: formatStamp(step.dueAt) })}</Time>
              )}
            </>
          ) : null}
          {step.attempts !== null && step.attempts >= 2 ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{t('task.steps.meta.attempt', { count: step.attempts })}</span>
            </>
          ) : null}
        </span>
      </span>
    </>
  );
  return (
    <li className={styles.step}>
      {step.source === 'inbox' ? (
        <Link to={cardLink(drawerBase.card(task.key))} className={clsx(styles.stepInner, styles.stepLink)}>
          {body}
        </Link>
      ) : (
        <div className={styles.stepInner}>{body}</div>
      )}
    </li>
  );
}

function RanRow({
  event,
  outcome,
  ctx,
  task,
}: {
  event: TimelineEvent;
  outcome: CardStepOutcome | null;
  ctx: TimelineContext;
  task: Task;
}) {
  const cardLink = useCardLink();
  const drawerBase = useDrawerBase();
  const described = describeEvent(event, ctx);
  return (
    <li className={styles.ranRow} data-outcome={outcome ?? 'none'}>
      <span className={styles.ranDot} data-outcome={outcome ?? 'none'} aria-hidden="true" />
      <div className={styles.ranBody}>
        <p className={styles.ranText}>
          {outcome ? <span className="visually-hidden">{t(`task.steps.outcome.${outcome}`)}: </span> : null}
          {described.text}
        </p>
        <div className={styles.ranFoot}>
          {outcome ? <Chip tone={OUTCOME_TONE[outcome]}>{t(`task.steps.outcome.${outcome}`)}</Chip> : null}
          <Link
            to={`${cardLink(drawerBase.card(task.key, 'timeline'))}#timeline-${event.id}`}
            className={styles.toTimeline}
          >
            {t('task.steps.toTimeline')}
          </Link>
        </div>
      </div>
      <Time value={event.createdAt} className={styles.ranTime} />
    </li>
  );
}

/** The card's Process view (PM-1151): what it waits for now, which steps are open, what ran and what failed. */
export function TaskSteps({
  task,
  state,
  steps,
  events,
  ctx,
}: {
  task: Task;
  state: TaskState | undefined;
  /** Absent: the server did not read them (the open-steps section is left out, no error). */
  steps: readonly CardStep[] | undefined;
  events: readonly TimelineEvent[];
  ctx: TimelineContext;
}) {
  const [all, setAll] = useState(false);
  const openId = useId();
  const ranId = useId();
  const nowId = useId();
  const ran = events
    .filter((event) => CARD_STEP_EVENT_TYPES.includes(event.type))
    .map((event) => ({ event, outcome: cardStepOutcome(event) }))
    .sort((a, b) => b.event.createdAt.localeCompare(a.event.createdAt));
  const failed = ran.filter((row) => row.outcome === 'failed').length;
  const handed = ran.filter((row) => row.outcome === 'handed_over').length;
  const shown = all ? ran : ran.slice(0, RAN_SHOWN);
  const first = (steps?.length ?? 0) === 0 && ran.length === 0;
  const now = Date.now();
  const stageName = ctx.pipeline?.stageById.get(task.stageId)?.name;

  const nowSection = state ? (
    <section className={drawer.section} aria-labelledby={nowId}>
      <h3 id={nowId} className={drawer.sectionTitle}>
        {t('task.steps.now')}
      </h3>
      <div className={clsx(styles.now, state.phase === 'done' && styles.nowDone)}>
        <p className={styles.nowText}>
          {state.phase === 'done' ? t('task.steps.doneNow') : state.next ? state.next.line : state.label}
        </p>
        <p className={styles.nowSince}>
          {stageName && state.phase !== 'done'
            ? t('task.steps.nowMeta', { stage: stageName, time: formatStamp(state.since) })
            : t('task.steps.since', { time: formatStamp(state.since) })}
        </p>
      </div>
    </section>
  ) : null;

  if (first) {
    return (
      <div className={styles.steps}>
        {nowSection}
        <div className={styles.first}>
          <p className={styles.firstTitle}>{t('task.steps.firstTitle')}</p>
          <p className={styles.firstBody}>{t('task.steps.firstBody')}</p>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.steps}>
      {nowSection}

      {steps ? (
        <section className={drawer.section} aria-labelledby={openId}>
          <h3 id={openId} className={drawer.sectionTitle}>
            {t('task.steps.open')}
            {steps.length > 0 ? <span className={styles.count}> · {steps.length}</span> : null}
          </h3>
          {steps.length > 0 ? (
            <ul className={styles.stepList}>
              {steps.map((step) => (
                <StepRow key={`${step.source}:${step.ref}`} step={step} task={task} ctx={ctx} now={now} />
              ))}
            </ul>
          ) : (
            <p className={styles.openEmpty}>{t('task.steps.openEmpty')}</p>
          )}
        </section>
      ) : null}

      <section className={drawer.section} aria-labelledby={ranId}>
        <h3 id={ranId} className={drawer.sectionTitle}>
          {t('task.steps.ran')}
        </h3>
        {ran.length === 0 ? (
          <p className={styles.openEmpty}>{t('task.steps.ranEmpty')}</p>
        ) : (
          <>
            <p className={styles.ranSummary}>
              <span>{t('task.steps.ranCount', { count: ran.length })}</span>
              {failed > 0 ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className={styles.failedCount}>{t('task.steps.ranFailed', { count: failed })}</span>
                </>
              ) : null}
              {handed > 0 ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className={styles.handedCount}>{t('task.steps.ranHanded', { count: handed })}</span>
                </>
              ) : null}
            </p>
            <ul className={styles.ranList}>
              {shown.map(({ event, outcome }) => (
                <RanRow key={event.id} event={event} outcome={outcome} ctx={ctx} task={task} />
              ))}
            </ul>
            {!all && ran.length > RAN_SHOWN ? (
              <button type="button" className={styles.earlier} onClick={() => setAll(true)}>
                {t('task.steps.earlier', { count: ran.length - RAN_SHOWN })}
              </button>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

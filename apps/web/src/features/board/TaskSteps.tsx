import { useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router';
import type { UseQueryResult } from '@tanstack/react-query';
import type { CardStep, Task, TaskDetail, TaskStartWaiting, TimelineEvent } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { Chip } from '../../components/Chip';
import type { ChipTone } from '../../components/Chip';
import { ErrorState, LoadingState } from '../../components/States';
import { formatAgo, formatStamp } from '../../i18n/format';
import { hasMessage, t, tDynamic } from '../../i18n/t';
import { buildCardStory } from '../../lib/cardStory';
import type { StoryRound } from '../../lib/cardStory';
import { inboxItemDomId } from '../../lib/inbox';
import { nameOf } from '../../lib/members';
import { startWaitingText } from '../../lib/taskState';
import type { TaskState } from '../../lib/taskState';
import type { TimelineContext } from '../../lib/timeline';
import { CardStory } from './CardStory';
import { nextStepLine } from './NextStep';
import { useAttachmentRows } from './TimelineAttachment';
import { useCardLink } from './cardSize';
import { useDrawerBase } from './drawerBase';
import drawer from './drawer.module.css';
import styles from './TaskSteps.module.css';

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

function Time({ value, children }: { value: string; children?: string }) {
  return (
    <time dateTime={value} title={formatStamp(value)}>
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
        // The item's own box on the Card view answers it.
        <Link
          to={`${cardLink(drawerBase.card(task.key))}${step.ref ? `#${inboxItemDomId(step.ref)}` : ''}`}
          className={clsx(styles.stepInner, styles.stepLink)}
        >
          {body}
        </Link>
      ) : (
        <div className={styles.stepInner}>{body}</div>
      )}
    </li>
  );
}

/** The "Most" box: the state, what the card waits for and who comes next. */
function Now({
  task,
  state,
  steps,
  round,
  ctx,
}: {
  task: Task;
  state: TaskState;
  /** Absent: the server did not read them (no waiting rows, no error). */
  steps: readonly CardStep[] | undefined;
  round: StoryRound | undefined;
  ctx: TimelineContext;
}) {
  const nowId = useId();
  const done = state.phase === 'done';
  const mine = steps?.some((step) => step.source === 'inbox' && step.holder === ctx.myHandle) ?? false;
  const next = ctx.pipeline ? nextStepLine(task, ctx.pipeline, ctx.members, ctx.myHandle) : null;
  const time = formatStamp(state.since);
  return (
    <section className={drawer.section} aria-labelledby={nowId}>
      <h3 id={nowId} className={drawer.sectionTitle}>
        {t('task.steps.now')}
      </h3>
      <div className={clsx(styles.now, done && styles.nowDone, mine && styles.nowMine)}>
        <p className={styles.nowText}>
          {done ? t('task.steps.doneNow') : state.next ? state.next.line : state.label}
        </p>
        <p className={styles.nowSince}>
          {round && !done
            ? t('task.steps.nowMeta', { stage: round.stageName, number: round.number, time })
            : t('task.steps.since', { time })}
        </p>
        {steps?.length ? (
          <>
            <h4 className={styles.waitTitle}>{t('task.steps.waitingFor')}</h4>
            <ul className={styles.stepList}>
              {steps.map((step) => (
                <StepRow
                  key={`${step.source}:${step.ref}`}
                  step={step}
                  task={task}
                  ctx={ctx}
                  now={Date.now()}
                />
              ))}
            </ul>
          </>
        ) : null}
        {next ? (
          <p className={styles.next}>
            <span className={styles.nextLabel}>{t('task.next')}</span> {next}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The card's Process view (PM-1160): the "Most" box (the state, what it waits for, who comes next), the comment
 * box and the story in rounds. A hidden view keeps only the comment box, so a draft survives the tab changes.
 */
export function TaskProcess({
  active,
  task,
  state,
  theme,
  detail,
  ctx,
  fullMessageHref,
  composer,
}: {
  active: boolean;
  task: Task;
  /** Absent for a theme: it has no "Most" box. */
  state: TaskState | undefined;
  theme: boolean;
  detail: Pick<UseQueryResult<TaskDetail>, 'data' | 'isPending' | 'isError' | 'error' | 'refetch'>;
  ctx: TimelineContext;
  fullMessageHref: (event: TimelineEvent) => string | null;
  composer: ReactNode;
}) {
  const data = detail.data;
  const { renderText, dialog } = useAttachmentRows(task, data?.timeline ?? []);
  const { pipeline, labels, members, myHandle, openInboxIds } = ctx;
  const story = useMemo(
    () =>
      data
        ? buildCardStory({
            task,
            events: data.timeline,
            earlierEvents: data.earlierEvents,
            theme,
            ctx: { pipeline, labels, members, myHandle, openInboxIds },
          })
        : null,
    [data, task.stageId, task.status, theme, pipeline, labels, members, myHandle, openInboxIds],
  );
  const wait = detail.isPending ? (
    <LoadingState compact />
  ) : detail.isError ? (
    <ErrorState
      compact
      error={detail.error}
      message={t('task.steps.loadFailed')}
      onRetry={() => void detail.refetch()}
    />
  ) : null;
  return (
    <div className={styles.steps}>
      {/* The tab names the view: the title stays for the screen readers. */}
      <h2 className={clsx(drawer.sectionTitle, 'visually-hidden')}>{t('task.steps.title')}</h2>
      {active
        ? (wait ??
          (state && !theme && story ? (
            <Now task={task} state={state} steps={data?.steps} round={story.rounds.at(-1)} ctx={ctx} />
          ) : null))
        : null}
      {composer}
      {active && story ? (
        <CardStory story={story} ctx={ctx} fullMessageHref={fullMessageHref} renderText={renderText} />
      ) : null}
      {dialog}
    </div>
  );
}

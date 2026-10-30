import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { cardStepOutcome } from '@projectman/shared';
import type { CardStepOutcome, TimelineEvent } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { Chip } from '../../components/Chip';
import type { ChipTone } from '../../components/Chip';
import { LabelChip } from '../../components/LabelChip';
import { SegmentedControl } from '../../components/SegmentedControl';
import { revealRow, TimelineRow } from '../../components/Timeline';
import { formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { locateEvent, roundRows, STORY_ROW_LIMIT } from '../../lib/cardStory';
import type { CardStory as Story, RoundOutcome, StoryRound, StoryView } from '../../lib/cardStory';
import { readStorage, writeStorage } from '../../lib/hooks';
import { nameOf } from '../../lib/members';
import type { TimelineContext } from '../../lib/timeline';
import drawer from './drawer.module.css';
import styles from './CardStory.module.css';

const VIEW_KEY = 'cardStory.view';
const OUTCOME_TONE: Record<RoundOutcome['kind'], ChipTone> = {
  running: 'accent',
  forward: 'ok',
  back: 'needs',
  moved: 'neutral',
  closed: 'ok',
};
const STEP_TONE: Record<CardStepOutcome, ChipTone> = { ran: 'ok', failed: 'blocked', handed_over: 'needs' };

const stageLabel = (ctx: TimelineContext, id: string) => ctx.pipeline?.stageById.get(id)?.name ?? id;

/** The words of a round's outcome chip, also for the "Most" box. */
function outcomeText(outcome: RoundOutcome, ctx: TimelineContext): string {
  if (outcome.kind === 'running') return t('task.story.outcome.running');
  if (outcome.kind === 'closed') return t(`task.story.outcome.${outcome.cancelled ? 'cancelled' : 'closed'}`);
  return t(`task.story.outcome.${outcome.kind}`, { stage: stageLabel(ctx, outcome.stageId) });
}

/** What an event came to, as a mark after its text: a failed or handed-over system step, the result labels. */
function badgeOf(event: TimelineEvent, ctx: TimelineContext): ReactNode {
  const step = cardStepOutcome(event);
  if (step === 'failed' || step === 'handed_over')
    return (
      <Chip tone={STEP_TONE[step]} className={styles.badge}>
        {t(`task.steps.outcome.${step}`)}
      </Chip>
    );
  if (event.type !== 'task_labels_changed' || !Array.isArray(event.data.added)) return null;
  const results = event.data.added.filter(
    (id): id is string =>
      typeof id === 'string' && Boolean(ctx.labels?.find((label) => label.id === id)?.group),
  );
  return results.map((id) => (
    <LabelChip key={id} id={id} labels={ctx.labels ?? []} className={styles.badge} />
  ));
}

function RoundHeader({
  round,
  ctx,
  open,
  panelId,
  onToggle,
}: {
  round: StoryRound;
  ctx: TimelineContext;
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  const column = round.color;
  return (
    <h4 className={styles.roundHead}>
      <button
        type="button"
        className={styles.roundButton}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={onToggle}
      >
        <span className={styles.dot} data-column-color={column ?? 'gray'} aria-hidden="true" />
        <span className={styles.roundMain}>
          <span className={styles.roundName}>
            {round.numbered
              ? t('task.story.roundNumbered', { stage: round.stageName, number: round.number })
              : round.stageName}
          </span>
          <span className={styles.roundActors}>
            {round.actors.map((handle) => (
              <Avatar key={handle} member={ctx.members.get(handle)} handle={handle} size="xs" />
            ))}
            <span className={styles.actorNames}>
              {round.actors.length
                ? round.actors.map((handle) => nameOf(handle, ctx.members, ctx.myHandle)).join(', ')
                : t('task.steps.system')}
            </span>
          </span>
          <span className={styles.roundSpan}>
            {formatStamp(round.start)} – {round.end ? formatStamp(round.end) : t('task.story.now')}
          </span>
        </span>
        <Chip tone={OUTCOME_TONE[round.outcome.kind]} className={styles.outcome}>
          <span className="visually-hidden">{t('task.story.outcomeLabel')}</span>
          {outcomeText(round.outcome, ctx)}
        </Chip>
      </button>
    </h4>
  );
}

/** The card's story (PM-1160): rounds in the stages, newest first, each with its events oldest first. */
export function CardStory({
  story,
  ctx,
  fullMessageHref,
  renderText,
}: {
  story: Story;
  ctx: TimelineContext;
  fullMessageHref: (event: TimelineEvent) => string | null;
  renderText: (event: TimelineEvent) => ReactNode;
}) {
  const { hash } = useLocation();
  const baseId = useId();
  const [view, setView] = useState<StoryView>(() => (readStorage(VIEW_KEY) === 'all' ? 'all' : 'essence'));
  // What the reader opened or closed; every other round is open when it is the latest.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [noiseOpen, setNoiseOpen] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  const [revealId, setRevealId] = useState<string | null>(null);
  const latest = story.rounds.at(-1)?.key;
  const events = useMemo(() => story.rounds.flatMap((round) => round.events), [story]);
  const add = (set: ReadonlySet<string>, key: string) => new Set(set).add(key);

  /** Opens whatever hides the event, then scrolls to it once it is on the page. */
  const reveal = (id: string): boolean => {
    const spot = locateEvent(story, id, view, ctx);
    if (!spot) return false;
    setToggled((map) => new Map(map).set(spot.roundKey, true));
    if (spot.noise) setNoiseOpen((set) => add(set, spot.roundKey));
    if (spot.earlier) setShowAll((set) => add(set, spot.roundKey));
    setRevealId(id);
    return true;
  };
  const reached = useRef('');
  useEffect(() => {
    if (!hash.startsWith('#timeline-') || reached.current === hash) return;
    if (reveal(hash.slice('#timeline-'.length))) reached.current = hash;
  }, [hash, story]);
  useLayoutEffect(() => {
    if (!revealId) return;
    const row = document.getElementById(`timeline-${revealId}`);
    if (!row) return;
    setRevealId(null);
    revealRow(row);
  }, [revealId, toggled, noiseOpen, showAll]);

  const chooseView = (next: StoryView) => {
    setView(next);
    writeStorage(VIEW_KEY, next);
  };
  const rowProps = { events, ctx, fullMessageHref, renderText, onJump: reveal };

  return (
    <section className={drawer.section} aria-labelledby={`${baseId}-title`}>
      <div className={styles.head}>
        <h3 id={`${baseId}-title`} className={drawer.sectionTitle}>
          {t('task.story.title')}
          {story.rounds.length > 1 ? (
            <span className={styles.count}> · {t('task.story.rounds', { count: story.rounds.length })}</span>
          ) : null}
        </h3>
        {story.first ? null : (
          <SegmentedControl
            size="sm"
            label={t('task.story.viewLabel')}
            value={view}
            onChange={chooseView}
            options={[
              { value: 'essence', label: t('task.story.view.essence') },
              { value: 'all', label: t('task.story.view.all') },
            ]}
          />
        )}
      </div>
      <div className={styles.rounds}>
        {[...story.rounds].reverse().map((round) => {
          const headless = round.stageId === null;
          const open = headless || (toggled.get(round.key) ?? round.key === latest);
          const panelId = `${baseId}-${round.key}`;
          const rows = roundRows(round, view, ctx);
          const hidden = showAll.has(round.key) ? 0 : Math.max(0, rows.length - STORY_ROW_LIMIT);
          const noise = noiseOpen.has(round.key);
          return (
            <div key={round.key} className={styles.round}>
              {headless ? null : (
                <RoundHeader
                  round={round}
                  ctx={ctx}
                  open={open}
                  panelId={panelId}
                  onToggle={() => setToggled((map) => new Map(map).set(round.key, !open))}
                />
              )}
              {open ? (
                <div id={panelId} className={styles.panel}>
                  {round.partial ? <p className={styles.partial}>{t('task.story.partial')}</p> : null}
                  {hidden > 0 ? (
                    <button
                      type="button"
                      className={styles.more}
                      onClick={() => setShowAll((set) => add(set, round.key))}
                    >
                      {t('task.story.earlier', { count: hidden })}
                    </button>
                  ) : null}
                  <ol className={styles.rows}>
                    {rows.slice(hidden).map((row) =>
                      row.kind === 'event' ? (
                        <TimelineRow
                          key={row.event.id}
                          event={row.event}
                          badge={badgeOf(row.event, ctx)}
                          {...rowProps}
                        />
                      ) : noise ? (
                        row.events.map((event) => (
                          <TimelineRow key={event.id} event={event} className={styles.noise} {...rowProps} />
                        ))
                      ) : (
                        <li key={row.events[0]!.id} className={styles.fold}>
                          <button
                            type="button"
                            className={styles.more}
                            onClick={() => setNoiseOpen((set) => add(set, round.key))}
                          >
                            {t('task.story.noise', { count: row.events.length })}
                            <span className="visually-hidden">{t('task.story.noiseShow')}</span>
                          </button>
                        </li>
                      ),
                    )}
                  </ol>
                  {noise ? (
                    <button
                      type="button"
                      className={styles.more}
                      onClick={() =>
                        setNoiseOpen((set) => {
                          const next = new Set(set);
                          next.delete(round.key);
                          return next;
                        })
                      }
                    >
                      {t('task.story.noiseHide')}
                    </button>
                  ) : null}
                </div>
              ) : (
                <p className={styles.summary}>{round.summary ?? t('task.story.passedThrough')}</p>
              )}
            </div>
          );
        })}
      </div>
      {story.first ? (
        <div className={styles.first}>
          <p className={styles.firstTitle}>{t('task.story.firstTitle')}</p>
          <p className={styles.firstBody}>{t('task.story.firstBody')}</p>
        </div>
      ) : null}
    </section>
  );
}

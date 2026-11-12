import { Fragment, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router';
import { isOnLeave, projectRefines, teamMap } from '@projectman/shared';
import type { MemberConfig, ProjectConfig, Stage, TeamMap, TeamMapStage } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { Avatar } from '../../../components/Avatar';
import { FlowLine } from '../../../components/flow/FlowLine';
import { FlowRow, FlowStation } from '../../../components/flow/FlowStation';
import { StageGlyph } from '../../../components/flow/StageGlyph';
import { Icon } from '../../../components/Icon';
import { LeaveChip } from '../../../components/LeaveChip';
import { joinNames, t } from '../../../i18n/t';
import { labelName } from '../../../lib/labels';
import { memberLike } from '../../how-we-work/MapContext';
import { labelViews } from '../../how-we-work/model';
import type { SettingsShow } from '../selection';
import { columnColor, columnRuns, emptyColumns, needsOwner } from './flow';
import styles from './PipelineFlow.module.css';
import type { PipelineMove } from './useMove';
import { useStageMove } from './useStageMove';

/** The owners shown as avatars in a stage's row (a phone shows nothing else). */
const SHOWN_AVATARS = 3;

type Selectable = { type: 'stage' | 'column'; id: string };

interface PipelineFlowProps {
  config: ProjectConfig;
  map: TeamMap;
  selected: SettingsShow | null;
  /** Stages a problem of the saved settings points at. */
  problemStages: ReadonlySet<string>;
  /** A stage that was just saved: its row lights up for a moment (`count` repeats it). */
  flash?: { id: string; count: number } | null;
  /** An admin adds stages and columns from the path itself. */
  canEdit?: boolean;
  /** Saves a move of stages made on the path (the drag, the keyboard on the handle). */
  mover: PipelineMove;
  onSelect(show: Selectable): void;
  /** The "+" under a stage: the new stage goes after it. */
  onNewStage?(after: string): void;
  onNewColumn?(): void;
}

const FLASH_MS = 1400;

/** The one hidden instruction every handle points at. */
const HELP_ID = 'pipeline-move-help';

/** The pipeline as a vertical path in the language of "Hogyan dolgozunk": columns as boxes, stages with their gates. */
export function PipelineFlow({
  config: saved,
  map: savedMap,
  selected,
  problemStages,
  flash,
  canEdit = false,
  mover,
  onSelect,
  onNewStage,
  onNewColumn,
}: PipelineFlowProps) {
  const { key, isOwner } = useProject();
  const flowRef = useRef<HTMLDivElement>(null);
  const move = useStageMove({ config: saved, isOwner, mover });
  // A grabbed stage, or a move being saved, is drawn in its new place without touching the saved settings.
  const config = useMemo(
    () => (move.shown ? { ...saved, pipeline: move.shown } : saved),
    [saved, move.shown],
  );
  const map = useMemo(() => (move.shown ? teamMap(config) : savedMap), [config, move.shown, savedMap]);
  const runs = useMemo(() => columnRuns(config.pipeline), [config.pipeline]);
  const empty = useMemo(() => emptyColumns(config.pipeline), [config.pipeline]);
  const members = useMemo(
    () => new Map(config.team.members.map((member) => [member.handle, member])),
    [config.team.members],
  );
  const stageNames = useMemo(
    () => new Map(config.pipeline.stages.map((stage) => [stage.id, stage.name])),
    [config.pipeline.stages],
  );
  const returns = map.fixRounds.loops.map((loop) => ({ fromId: loop.fromStageId, toId: loop.toStageId }));
  const refines = projectRefines(config);
  const firstStageId = config.pipeline.stages[0]?.id;
  const selectedValue =
    selected && 'id' in selected
      ? `${selected.type}:${selected.id}`
      : selected?.type === 'new-column'
        ? 'new-column'
        : null;
  useEffect(() => {
    if (!selectedValue) return;
    const row = [...(flowRef.current?.querySelectorAll<HTMLElement>('[data-show]') ?? [])].find(
      (element) => element.dataset.show === selectedValue,
    );
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedValue]);
  useEffect(() => {
    if (!flash) return;
    const row = [...(flowRef.current?.querySelectorAll<HTMLElement>('[data-show]') ?? [])].find(
      (element) => element.dataset.show === `stage:${flash.id}`,
    );
    // Centred: the toast covers the bottom of the screen.
    row?.scrollIntoView?.({ block: 'center' });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    row?.animate?.([{ backgroundColor: 'var(--c-accent-bg)' }, { backgroundColor: 'transparent' }], {
      duration: FLASH_MS,
      easing: 'ease-out',
    });
  }, [flash]);

  return (
    <div ref={flowRef} className={styles.flow} {...(canEdit ? move.pathDrop : {})}>
      <FlowLine containerRef={flowRef} returns={returns} watch={map} />
      <div className="visually-hidden" aria-live="polite">
        {move.announcement}
      </div>
      {canEdit ? (
        <p id={HELP_ID} className="visually-hidden">
          {t('settings.pipeline.move.help')}
        </p>
      ) : null}
      <ol className={styles.runs}>
        {runs.map((run) => {
          const color = columnColor(config.pipeline, run.column);
          const headMark = move.mark?.anchor.kind === 'head' && move.mark.anchor.run.start === run.start;
          return (
            <li key={`${run.column.id}:${run.start}`}>
              <div
                className={clsx(
                  styles.col,
                  headMark && (move.mark?.reason ? styles.dropHeadRefused : styles.dropHead),
                )}
                style={
                  {
                    '--col-bg': `var(--column-${color}-bg)`,
                    '--col-fg': `var(--column-${color}-fg)`,
                  } as CSSProperties
                }
              >
                <button
                  type="button"
                  className={styles.colHead}
                  aria-pressed={selectedValue === `column:${run.column.id}`}
                  data-show={`column:${run.column.id}`}
                  onClick={() => onSelect({ type: 'column', id: run.column.id })}
                  {...(canEdit ? move.headDrop(run) : {})}
                >
                  {t('howWeWork.flow.column', { name: run.column.name })}
                </button>
                {headMark && move.mark?.reason ? (
                  <span className={styles.grabReason} data-testid="drop-reason">
                    {t('settings.pipeline.move.forbidden', { reason: move.mark.reason })}
                  </span>
                ) : null}
                <ol className={styles.stages}>
                  {run.stages.map((stage, offset) => {
                    const entry = map.stages[run.start + offset]!;
                    const mark =
                      move.mark?.anchor.kind === 'stage' && move.mark.anchor.id === stage.id
                        ? move.mark
                        : null;
                    const anchor = mark?.anchor.kind === 'stage' ? mark.anchor : null;
                    const saving = move.saving.includes(stage.id);
                    return (
                      <li key={stage.id} {...(canEdit ? move.stageDrop(stage) : {})}>
                        {mark && anchor?.edge === 'before' ? <DropMark reason={mark.reason} /> : null}
                        <GateRow entry={entry} map={map} />
                        <div
                          className={clsx(
                            styles.stationWrap,
                            move.dragging === stage.id && styles.dragging,
                            move.grabbed === stage.id && styles.grabbed,
                            move.grabbed === stage.id && move.grabReason && styles.grabbedRefused,
                            saving && styles.saving,
                          )}
                          aria-busy={saving || undefined}
                        >
                          {canEdit ? <StageHandle stage={stage} props={move.handleProps(stage)} /> : null}
                          <Station
                            entry={entry}
                            members={members}
                            selected={selectedValue === `stage:${stage.id}`}
                            problem={problemStages.has(stage.id)}
                            onSelect={() => onSelect({ type: 'stage', id: stage.id })}
                          />
                        </div>
                        {saving ? (
                          <p className={styles.savingMark}>{t('settings.pipeline.edit.saving')}</p>
                        ) : null}
                        {move.grabbed === stage.id && move.grabReason ? (
                          <span className={styles.grabReason}>
                            {t('settings.pipeline.move.forbidden', { reason: move.grabReason })}
                          </span>
                        ) : null}
                        {mark && anchor?.edge === 'after' ? <DropMark reason={mark.reason} /> : null}
                        {map.fixRounds.loops
                          .filter((loop) => loop.fromStageId === stage.id)
                          .map((loop) => (
                            <FlowRow key={loop.toStageId} className={styles.subRow}>
                              <span className={styles.loop}>
                                <Icon name="undo" size={14} strokeWidth={2} />
                                <span>
                                  {t('howWeWork.flow.loop', {
                                    stage: stageNames.get(loop.toStageId) ?? loop.toStageId,
                                    limit: map.fixRounds.limit,
                                  })}
                                </span>
                              </span>
                            </FlowRow>
                          ))}
                        {refines && stage.id === firstStageId ? (
                          <FlowRow className={styles.subRow}>
                            <span className={styles.refine}>
                              <Icon name="list" size={15} />
                              <span>
                                {t('settings.pipeline.refineRow')}{' '}
                                <Link to={`/p/${key}/how-we-work`}>
                                  {t('settings.pipeline.howWeWorkLink')}
                                </Link>
                              </span>
                            </span>
                          </FlowRow>
                        ) : null}
                        {canEdit && onNewStage && !isEnd(config, stage.id) ? (
                          <button
                            type="button"
                            className={styles.insert}
                            aria-label={t('settings.pipeline.insertAfter', { name: stage.name })}
                            onClick={() => onNewStage(stage.id)}
                          >
                            <Icon name="plus" size={14} />
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </div>
            </li>
          );
        })}
      </ol>
      {empty.length > 0 || canEdit ? (
        <div className={styles.emptyColumns}>
          <span>
            {empty.length > 0 ? t('settings.pipeline.emptyColumns') : t('settings.pipeline.noEmptyColumns')}
          </span>
          {empty.map((column) => (
            <button
              key={column.id}
              type="button"
              className={styles.emptyColumn}
              aria-pressed={selectedValue === `column:${column.id}`}
              data-show={`column:${column.id}`}
              onClick={() => onSelect({ type: 'column', id: column.id })}
            >
              {column.name}
            </button>
          ))}
          {canEdit && onNewColumn ? (
            <button
              type="button"
              className={clsx(styles.emptyColumn, styles.addColumn)}
              aria-pressed={selectedValue === 'new-column'}
              data-show="new-column"
              onClick={onNewColumn}
            >
              <Icon name="plus" size={13} /> {t('settings.pipeline.addColumn')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The line a dragged stage would land on; red with the reason when the place is not allowed. */
function DropMark({ reason }: { reason: string | null }) {
  return (
    <div className={styles.dropMark} data-refused={reason ? '' : undefined}>
      {reason ? (
        <span className={styles.reason} data-testid="drop-reason">
          {t('settings.pipeline.move.forbidden', { reason })}
        </span>
      ) : null}
    </div>
  );
}

/** The grip at the left of a stage's row: drag it, or grab it with the keyboard. */
function StageHandle({
  stage,
  props,
}: {
  stage: Stage;
  props: ReturnType<ReturnType<typeof useStageMove>['handleProps']>;
}) {
  return (
    <div className={styles.handle} title={t('settings.pipeline.move.handleTip')} {...props.wrap}>
      <button
        type="button"
        aria-label={t('settings.pipeline.move.handle', { name: stage.name })}
        aria-describedby={HELP_ID}
        {...props.button}
      >
        <Icon name="grip" size={16} />
      </button>
    </div>
  );
}

/** Nothing can follow the last stage when it is the end of the path. */
function isEnd(config: ProjectConfig, stageId: string): boolean {
  const last = config.pipeline.stages[config.pipeline.stages.length - 1];
  return last?.id === stageId && last.kind === 'done';
}

function GateRow({ entry, map }: { entry: TeamMapStage; map: TeamMap }) {
  const conditions = entry.stage.gate?.conditions ?? [];
  if (conditions.length === 0) return null;
  const groups = [
    {
      lacks: false,
      title: t('howWeWork.flow.gateNeeds'),
      items: conditions.filter((c) => c.type === 'has_label'),
    },
    {
      lacks: true,
      title: t('howWeWork.flow.gateLacks'),
      items: conditions.filter((c) => c.type === 'lacks_label'),
    },
  ].filter((group) => group.items.length > 0);
  const views = labelViews(map);
  return (
    <FlowRow
      className={styles.gateRow}
      mark={
        <span className={styles.gateMark} title={t('howWeWork.flow.gate')}>
          <Icon name="lock" size={12} strokeWidth={2.2} />
        </span>
      }
    >
      <div className={styles.gateBody}>
        {groups.map((group) => (
          <span key={group.title} className={styles.gateGroup}>
            <span className={styles.gateLabel}>{group.title}:</span>
            {group.items.map((condition) => {
              const label = map.labels.find((candidate) => candidate.label.id === condition.label);
              const color = label?.label.color;
              return (
                <span
                  key={`${condition.label}:${condition.when ?? ''}`}
                  className={clsx(styles.chip, condition.when && styles.cond, group.lacks && styles.lacks)}
                  style={
                    color
                      ? ({
                          '--lab-fg': `var(--column-${color}-fg)`,
                          '--lab-bg': `var(--column-${color}-bg)`,
                        } as CSSProperties)
                      : undefined
                  }
                >
                  {label?.approval ? (
                    <span className={styles.human} title={t('howWeWork.humanOnlyHidden')}>
                      <Icon name="user" size={13} strokeWidth={2.4} />
                    </span>
                  ) : null}
                  <span className={styles.chipName}>{labelName(condition.label, views)}</span>
                  {condition.when ? (
                    <span className={styles.when}>
                      {t('howWeWork.flow.when', { name: labelName(condition.when, views) })}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </span>
        ))}
      </div>
    </FlowRow>
  );
}

function Station({
  entry,
  members,
  selected,
  problem,
  onSelect,
}: {
  entry: TeamMapStage;
  members: ReadonlyMap<string, MemberConfig>;
  selected: boolean;
  problem: boolean;
  onSelect(): void;
}) {
  const { stage } = entry;
  const kind = t(`stageKinds.${stage.kind}`);
  return (
    <FlowStation
      glyph={<StageGlyph kind={stage.kind} glyphId={stage.id} />}
      selected={selected}
      showId={`stage:${stage.id}`}
      onClick={onSelect}
      aside={<Owners entry={entry} members={members} />}
    >
      <span className={styles.stTitle}>
        <span className={styles.stName}>{stage.name}</span>
        {entry.humanDecides ? (
          <span className={styles.humanTag}>
            <Icon name="user" size={12} strokeWidth={2.2} />
            {t('howWeWork.humanDecides')}
          </span>
        ) : null}
        {problem ? (
          <span className={styles.problem} role="img" aria-label={t('settings.pipeline.problem')}>
            <Icon name="exclamation" size={15} />
          </span>
        ) : null}
      </span>
      <span className={styles.stKind}>
        {entry.duty ? t('settings.pipeline.kindDuty', { kind, duty: t(`dutyNames.${entry.duty}`) }) : kind}
        {entry.smallCards
          ? ` · ${t('howWeWork.flow.smallCards', {
              points: entry.smallCards.maxPoints,
              names: joinNames(
                entry.smallCards.owners.map((handle) => members.get(handle)?.displayName ?? handle),
              ),
            })}`
          : null}
      </span>
      {stage.description ? <span className={styles.stSub}>{stage.description}</span> : null}
    </FlowStation>
  );
}

/** The names joined the Hungarian way, each member on leave with its mark. */
function OwnerNames({ people }: { people: readonly MemberConfig[] }) {
  return (
    <>
      {people.map((person, index) => (
        <Fragment key={person.handle}>
          {index === 0 ? null : index === people.length - 1 ? t('common.and') : t('common.listSeparator')}
          <span>
            {person.displayName}
            {isOnLeave(person) ? (
              <>
                {' '}
                <LeaveChip member={person} />
              </>
            ) : null}
          </span>
        </Fragment>
      ))}
    </>
  );
}

function Owners({ entry, members }: { entry: TeamMapStage; members: ReadonlyMap<string, MemberConfig> }) {
  const people = entry.owners.flatMap((handle) => {
    const member = members.get(handle);
    return member ? [member] : [];
  });
  if (people.length === 0)
    return needsOwner(entry) ? (
      <span className={styles.noOwner}>
        <Icon name="exclamation" size={14} />
        {t('howWeWork.flow.noOwner')}
      </span>
    ) : null;
  const rest = people.length - SHOWN_AVATARS;
  return (
    <>
      <span className={styles.ownerNames}>
        {people.length > SHOWN_AVATARS ? (
          t('howWeWork.flow.ownersMore', {
            names: people
              .slice(0, 2)
              .map((person) => person.displayName)
              .join(t('common.listSeparator')),
            count: people.length - 2,
          })
        ) : (
          <OwnerNames people={people} />
        )}
      </span>
      <span className={styles.avatars}>
        {people.slice(0, SHOWN_AVATARS).map((person) => (
          <span key={person.handle} className={clsx(styles.avatar, isOnLeave(person) && styles.onLeave)}>
            <Avatar member={memberLike(person)} size="sm" variant="initials" ring />
          </span>
        ))}
        {rest > 0 ? <span className={styles.more}>{t('common.moreCount', { count: rest })}</span> : null}
      </span>
    </>
  );
}

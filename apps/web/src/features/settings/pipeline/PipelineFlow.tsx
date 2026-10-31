import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router';
import { isOnLeave, projectRefines } from '@projectman/shared';
import type { MemberConfig, ProjectConfig, TeamMap, TeamMapStage } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { Avatar } from '../../../components/Avatar';
import { FlowLine } from '../../../components/flow/FlowLine';
import { FlowRow, FlowStation } from '../../../components/flow/FlowStation';
import { StageGlyph } from '../../../components/flow/StageGlyph';
import { Icon } from '../../../components/Icon';
import { joinNames, t } from '../../../i18n/t';
import { labelName } from '../../../lib/labels';
import { memberLike } from '../../how-we-work/MapContext';
import { labelViews } from '../../how-we-work/model';
import type { SettingsShow } from '../selection';
import { columnColor, columnRuns, emptyColumns, needsOwner } from './flow';
import styles from './PipelineFlow.module.css';

/** The owners shown as avatars in a stage's row (a phone shows nothing else). */
const SHOWN_AVATARS = 3;

type Selectable = { type: 'stage' | 'column'; id: string };

interface PipelineFlowProps {
  config: ProjectConfig;
  map: TeamMap;
  selected: SettingsShow | null;
  /** Stages a problem of the saved settings points at. */
  problemStages: ReadonlySet<string>;
  onSelect(show: Selectable): void;
}

/** The pipeline as a vertical path in the language of "Hogyan dolgozunk": columns as boxes, stages with their gates. */
export function PipelineFlow({ config, map, selected, problemStages, onSelect }: PipelineFlowProps) {
  const { key } = useProject();
  const flowRef = useRef<HTMLDivElement>(null);
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
  const selectedValue = selected && 'id' in selected ? `${selected.type}:${selected.id}` : null;
  useEffect(() => {
    if (!selectedValue) return;
    const row = [...(flowRef.current?.querySelectorAll<HTMLElement>('[data-show]') ?? [])].find(
      (element) => element.dataset.show === selectedValue,
    );
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedValue]);

  return (
    <div ref={flowRef} className={styles.flow}>
      <FlowLine containerRef={flowRef} returns={returns} watch={map} />
      <ol className={styles.runs}>
        {runs.map((run) => {
          const color = columnColor(config.pipeline, run.column);
          return (
            <li key={`${run.column.id}:${run.start}`}>
              <div
                className={styles.col}
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
                >
                  {t('howWeWork.flow.column', { name: run.column.name })}
                </button>
                <ol className={styles.stages}>
                  {run.stages.map((stage, offset) => {
                    const entry = map.stages[run.start + offset]!;
                    return (
                      <li key={stage.id}>
                        <GateRow entry={entry} map={map} />
                        <Station
                          entry={entry}
                          members={members}
                          selected={selectedValue === `stage:${stage.id}`}
                          problem={problemStages.has(stage.id)}
                          onSelect={() => onSelect({ type: 'stage', id: stage.id })}
                        />
                        {map.fixRounds.loops
                          .filter((loop) => loop.fromStageId === stage.id)
                          .map((loop) => (
                            <FlowRow key={loop.toStageId} className={styles.subRow}>
                              <span className={styles.loop}>
                                <Icon name="undo" size={14} strokeWidth={2} />
                                {t('howWeWork.flow.loop', {
                                  stage: stageNames.get(loop.toStageId) ?? loop.toStageId,
                                  limit: map.fixRounds.limit,
                                })}
                              </span>
                            </FlowRow>
                          ))}
                        {refines && stage.id === firstStageId ? (
                          <FlowRow className={styles.subRow}>
                            <span className={styles.refine}>
                              <Icon name="list" size={15} />
                              {t('settings.pipeline.refineRow')}{' '}
                              <Link to={`/p/${key}/how-we-work`}>{t('settings.pipeline.howWeWorkLink')}</Link>
                            </span>
                          </FlowRow>
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
      {empty.length > 0 ? (
        <div className={styles.emptyColumns}>
          <span>{t('settings.pipeline.emptyColumns')}</span>
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
        </div>
      ) : null}
    </div>
  );
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
      </span>
      {stage.description ? <span className={styles.stSub}>{stage.description}</span> : null}
    </FlowStation>
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
  const names = people.map((person) => person.displayName);
  const shown =
    names.length > 3
      ? t('howWeWork.flow.ownersMore', {
          names: names.slice(0, 2).join(t('common.listSeparator')),
          count: names.length - 2,
        })
      : joinNames(names);
  const rest = people.length - SHOWN_AVATARS;
  return (
    <>
      <span className={styles.ownerNames}>{shown}</span>
      <span className={styles.avatars}>
        {people.slice(0, SHOWN_AVATARS).map((person) => (
          <span
            key={person.handle}
            className={clsx(styles.avatar, isOnLeave(person) && styles.onLeave)}
            title={isOnLeave(person) ? t('leave.onLeave') : undefined}
          >
            <Avatar member={memberLike(person)} size="sm" variant="initials" ring />
          </span>
        ))}
        {rest > 0 ? <span className={styles.more}>{t('common.moreCount', { count: rest })}</span> : null}
      </span>
    </>
  );
}

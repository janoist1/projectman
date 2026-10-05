import { useRef } from 'react';
import type { TeamMapStage } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { FlowLine } from '../../components/flow/FlowLine';
import { FlowRow, FlowStation } from '../../components/flow/FlowStation';
import { StageGlyph } from '../../components/flow/StageGlyph';
import { Icon } from '../../components/Icon';
import { rich, joinNodes } from '../../i18n/rich';
import { joinNames, t } from '../../i18n/t';
import { humanRoleName } from '../../lib/roles';
import { LabelButton, OwnerStack } from './parts';
import { memberLike, useMapView, useShowTarget } from './MapContext';
import { stageColumns } from './model';
import styles from './HowWeWork.module.css';

/** "A card's way": the start, the stages in their board columns with their gates, and what can stop a card anywhere. */
export function FlowSection({ flashed }: { flashed: ReadonlySet<string> }) {
  const { map, config } = useMapView();
  const flowRef = useRef<HTMLDivElement>(null);
  const columns = stageColumns(map, config.pipeline.columns);
  const returns = map.fixRounds.loops.map((loop) => ({ fromId: loop.fromStageId, toId: loop.toStageId }));
  const first = map.stages[0];
  return (
    <div ref={flowRef} className={styles.flow}>
      <FlowLine containerRef={flowRef} returns={returns} watch={map} />
      <StartRow />
      {columns.map(({ column, color, stages }) => {
        const named = stages.length > 1 || stages[0]?.stage.name !== column.name;
        return (
          <section
            key={`${column.id}:${stages[0]?.stage.id}`}
            className={styles.col}
            style={
              { '--col-bg': `var(--column-${color}-bg)`, '--col-fg': `var(--column-${color}-fg)` } as never
            }
            aria-label={t('howWeWork.flow.column', { name: column.name })}
          >
            {named ? (
              <div className={styles.colName}>{t('howWeWork.flow.column', { name: column.name })}</div>
            ) : null}
            {stages.map((entry) => (
              <StageRows
                key={entry.stage.id}
                entry={entry}
                flash={flashed.has(entry.stage.id)}
                withRefinement={entry === first}
              />
            ))}
          </section>
        );
      })}
      <StopBand />
    </div>
  );
}

function StartRow() {
  const { map, stageName } = useMapView();
  const rule = map.rules.find((entry) => entry.id === 'new_card');
  const show = useShowTarget({ kind: 'rule', id: 'new_card' });
  if (rule?.id !== 'new_card') return null;
  return (
    <div className={styles.startRow}>
      <FlowStation
        glyph={
          <span className={styles.startDot} data-glyph="start">
            <Icon name="plus" size={12} strokeWidth={2.4} />
          </span>
        }
        selected={show.pressed}
        showId={show.value}
        onClick={show.open}
      >
        <span className={styles.startText}>
          {rich('howWeWork.flow.start', {
            access: humanRoleName(rule.minimumAccess),
            stage: stageName(rule.firstStageId),
          })}
        </span>
      </FlowStation>
    </div>
  );
}

function StageRows({
  entry,
  flash,
  withRefinement,
}: {
  entry: TeamMapStage;
  flash: boolean;
  withRefinement: boolean;
}) {
  return (
    <>
      <GateRow entry={entry} />
      <Station entry={entry} flash={flash} />
      {withRefinement ? <RefinementRow /> : null}
    </>
  );
}

function GateRow({ entry }: { entry: TeamMapStage }) {
  const conditions = entry.stage.gate?.conditions ?? [];
  if (conditions.length === 0) return null;
  const has = conditions.filter((condition) => condition.type === 'has_label');
  const lacks = conditions.filter((condition) => condition.type === 'lacks_label');
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
        {has.length > 0 ? (
          <>
            <span className={styles.gateLabel}>{t('howWeWork.flow.gateNeeds')}</span>
            {has.map((condition) => (
              <LabelButton
                key={`${condition.label}:${condition.when ?? ''}`}
                id={condition.label}
                when={condition.when}
              />
            ))}
          </>
        ) : null}
        {lacks.length > 0 ? (
          <>
            <span className={styles.gateLabel}>{t('howWeWork.flow.gateLacks')}</span>
            {lacks.map((condition) => (
              <LabelButton
                key={`${condition.label}:${condition.when ?? ''}`}
                id={condition.label}
                when={condition.when}
                lacks
              />
            ))}
          </>
        ) : null}
      </div>
    </FlowRow>
  );
}

function Station({ entry, flash }: { entry: TeamMapStage; flash: boolean }) {
  const { map, stageName } = useMapView();
  const { stage } = entry;
  const show = useShowTarget({ kind: 'stage', id: stage.id });
  const loop = map.fixRounds.loops.find((candidate) => candidate.fromStageId === stage.id);
  const sub =
    stage.description || (entry.duty ? t(`dutyNames.${entry.duty}`) : t(`howWeWork.kindHints.${stage.kind}`));
  return (
    <FlowStation
      glyph={<StageGlyph kind={stage.kind} glyphId={stage.id} />}
      selected={show.pressed}
      flash={flash}
      showId={show.value}
      onClick={show.open}
      aside={<Owners entry={entry} />}
    >
      <span className={styles.stTitle}>
        <span className={styles.stName}>{stage.name}</span>
        <span className={styles.kind}>{t(`stageKinds.${stage.kind}`)}</span>
        {entry.humanDecides ? (
          <span className={styles.humanTag}>
            <Icon name="user" size={12} strokeWidth={2.2} />
            {t('howWeWork.humanDecides')}
          </span>
        ) : null}
      </span>
      <span className={styles.stSub}>{sub}</span>
      {loop ? (
        <span className={styles.stLoop}>
          <Icon name="loop" size={14} strokeWidth={2} />
          {t('howWeWork.flow.loop', { stage: stageName(loop.toStageId), limit: map.fixRounds.limit })}
        </span>
      ) : null}
    </FlowStation>
  );
}

function Owners({ entry }: { entry: TeamMapStage }) {
  const { member } = useMapView();
  const people = entry.owners.flatMap((handle) => {
    const config = member(handle);
    return config ? [config] : [];
  });
  if (people.length === 0) return <span className={styles.noOwner}>{t('howWeWork.flow.noOwner')}</span>;
  const names = people.map((person) => person.displayName);
  const shown =
    names.length > 3
      ? t('howWeWork.flow.ownersMore', {
          names: names.slice(0, 2).join(t('common.listSeparator')),
          count: names.length - 2,
        })
      : joinNames(names);
  return (
    <>
      <span className={styles.ownerNames}>{shown}</span>
      <OwnerStack handles={people.map((person) => person.handle)} />
      <span className={styles.ownerCount}>
        {people.length === 1 ? names[0] : t('howWeWork.flow.ownerCount', { count: people.length })}
      </span>
    </>
  );
}

/** Under the first stage: the steps a card that needs refining goes through before it is developed, in order. */
function RefinementRow() {
  const { map, labels, member } = useMapView();
  const refinement = map.refinement;
  const show = useShowTarget({ kind: 'rule', id: 'refinement' });
  if (!refinement || refinement.steps.length === 0) return null;
  const names = new Map(labels.map((label) => [label.id, label.name]));
  return (
    <FlowRow className={styles.subRow}>
      <button
        type="button"
        className={styles.refine}
        aria-pressed={show.pressed}
        data-show={show.value}
        onClick={(event) => show.open(event.currentTarget)}
      >
        <Icon name="list" size={15} />
        <b>{t('howWeWork.flow.refine')}</b>
        {refinement.steps.map((step, index) => {
          const setters = step.aiSetters.flatMap((handle) => {
            const config = member(handle);
            return config ? [config] : [];
          });
          return (
            <span key={`${step.stageId}:${step.label}`} className={styles.stepGroup}>
              <span className={styles.step}>
                <span className={styles.stepNo}>{index + 1}</span>
                {names.get(step.label) ?? step.label}
                {setters.slice(0, 2).map((setter) => (
                  <Avatar key={setter.handle} member={memberLike(setter)} size="xs" />
                ))}
              </span>
              {index < refinement.steps.length - 1 ? (
                <span className={styles.sep}>
                  <Icon name="chevronRight" size={12} />
                </span>
              ) : null}
            </span>
          );
        })}
        <span className={styles.sep}>{t('howWeWork.flow.refineOneAtATime')}</span>
      </button>
    </FlowRow>
  );
}

/** A card can stop at any step: a label that holds it back, and a question that waits for an answer. */
function StopBand() {
  const { map } = useMapView();
  if (map.blockingLabels.length === 0) return null;
  const asks = map.rules.some((rule) => rule.id === 'waiting_answer');
  return (
    <div className={styles.band}>
      <span className={styles.bandIcon}>
        <Icon name="wait" size={15} />
      </span>
      <span>
        <b>{t('howWeWork.flow.stoppable')}</b>{' '}
        {rich('howWeWork.flow.stoppableText', {
          labels: joinNodes(map.blockingLabels.map((id) => <LabelButton key={id} id={id} />)),
        })}
        {asks ? <> {t('howWeWork.flow.stoppableAsk')}</> : null}
      </span>
    </div>
  );
}

import { useMemo } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router';
import { isOnLeave, isTheme, teamMap } from '@projectman/shared';
import type { ProjectConfig, StageKind, TeamMap, TeamMapStage } from '@projectman/shared';
import { useBoard } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { Avatar } from '../../../components/Avatar';
import { StageGlyph } from '../../../components/flow/StageGlyph';
import { Icon } from '../../../components/Icon';
import { LeaveChip } from '../../../components/LeaveChip';
import { t } from '../../../i18n/t';
import { gateConditionText } from '../../../lib/gates';
import { memberLike } from '../../how-we-work/MapContext';
import { labelViews } from '../../how-we-work/model';
import { DetailPanel, MissingSettingsElement } from '../DetailPanel';
import type { SettingsShow } from '../selection';
import { columnColor, needsOwner } from './flow';
import styles from './PipelinePanel.module.css';

const STAGE_KINDS: readonly StageKind[] = ['queue', 'work', 'step', 'release', 'done'];

interface PipelinePanelProps {
  config: ProjectConfig;
  show: SettingsShow | null;
  /** Arrived from "Hogyan dolgozunk": the panel offers the way back. */
  fromHowWeWork: boolean;
  /** A phone's legend button opened the panel without a selection. */
  legendOpen: boolean;
  onSelect(show: SettingsShow): void;
  onClose(): void;
}

/** The read-only details of the selected stage or column, or the legend while nothing is selected. */
export function PipelinePanel({
  config,
  show,
  fromHowWeWork,
  legendOpen,
  onSelect,
  onClose,
}: PipelinePanelProps) {
  const { key, can } = useProject();
  const map = useMemo(() => teamMap(config), [config]);
  const board = useBoard(key);
  const target = show?.type === 'stage' || show?.type === 'column' ? show : null;
  const empty = (
    <>
      <h2 className={styles.emptyTitle}>{t('settings.pipeline.emptyTitle')}</h2>
      <PipelineLegend />
    </>
  );
  if (target?.type === 'stage') {
    const entry = map.stages.find((candidate) => candidate.stage.id === target.id);
    if (entry) {
      const cards = board.data
        ? board.data.tasks.filter((task) => !isTheme(task) && task.stageId === target.id).length
        : null;
      return (
        <DetailPanel
          open
          itemKey={`stage:${target.id}`}
          kicker={t('settings.pipeline.kickerStage', { kind: t(`stageKinds.${entry.stage.kind}`) })}
          title={entry.stage.name}
          back={
            fromHowWeWork ? (
              <Link className={styles.back} to={`/p/${key}/how-we-work?show=stage:${target.id}`}>
                {t('settings.pipeline.back')}
              </Link>
            ) : undefined
          }
          empty={empty}
          onClose={onClose}
        >
          <StageDetail
            config={config}
            map={map}
            entry={entry}
            cards={cards}
            canEdit={can.manageTeam}
            onSelect={onSelect}
          />
        </DetailPanel>
      );
    }
  }
  if (target?.type === 'column') {
    const column = config.pipeline.columns.find((candidate) => candidate.id === target.id);
    if (column)
      return (
        <DetailPanel
          open
          itemKey={`column:${target.id}`}
          kicker={t('settings.pipeline.kickerColumn')}
          title={column.name}
          empty={empty}
          onClose={onClose}
        >
          <ColumnDetail
            config={config}
            map={map}
            columnId={column.id}
            canEdit={can.manageTeam}
            onSelect={onSelect}
          />
        </DetailPanel>
      );
  }
  if (target)
    return (
      <DetailPanel open itemKey="gone" title={t('howWeWork.gone.title')} empty={empty} onClose={onClose}>
        <MissingSettingsElement onClose={onClose} />
      </DetailPanel>
    );
  return (
    <DetailPanel
      open={legendOpen}
      itemKey="legend"
      title={t('howWeWork.legendButton')}
      empty={empty}
      onClose={onClose}
    >
      <PipelineLegend />
    </DetailPanel>
  );
}

function Note({ canEdit }: { canEdit: boolean }) {
  return (
    <p className={styles.note}>
      {canEdit ? t('settings.pipeline.adminNote') : t('settings.pipeline.memberNote')}
    </p>
  );
}

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <dt>{title}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function StageDetail({
  config,
  map,
  entry,
  cards,
  canEdit,
  onSelect,
}: {
  config: ProjectConfig;
  map: TeamMap;
  entry: TeamMapStage;
  /** The cards in the stage, or null while the board is not known. */
  cards: number | null;
  canEdit: boolean;
  onSelect(show: SettingsShow): void;
}) {
  const { stage } = entry;
  const column = config.pipeline.columns.find((candidate) => candidate.id === stage.columnId);
  const labels = labelViews(map);
  const members = new Map(config.team.members.map((member) => [member.handle, member]));
  const owners = entry.owners.flatMap((handle) => {
    const member = members.get(handle);
    return member ? [member] : [];
  });
  const conditions = stage.gate?.conditions ?? [];
  return (
    <>
      {stage.description ? <p className={styles.lead}>{stage.description}</p> : null}
      <dl className={styles.fields}>
        <Field title={t('settings.pipeline.fields.column')}>
          <button
            type="button"
            className={styles.link}
            onClick={() => onSelect({ type: 'column', id: stage.columnId })}
          >
            {column?.name ?? stage.columnId}
          </button>
        </Field>
        {entry.duty ? (
          <Field title={t('settings.pipeline.fields.duty')}>{t(`dutyNames.${entry.duty}`)}</Field>
        ) : null}
        <Field title={t('settings.pipeline.fields.owners')}>
          {owners.length === 0 ? (
            needsOwner(entry) ? (
              <span className={styles.noOwner}>
                <Icon name="exclamation" size={14} />
                {t('howWeWork.flow.noOwner')}
              </span>
            ) : (
              <span className={styles.muted}>{t('howWeWork.flow.noOwner')}</span>
            )
          ) : (
            <ul className={styles.list}>
              {owners.map((member) => (
                <li key={member.handle} className={styles.person}>
                  <span className={clsx(styles.avatar, isOnLeave(member) && styles.onLeave)}>
                    <Avatar member={memberLike(member)} size="sm" variant="initials" ring />
                  </span>
                  {member.displayName}
                  <LeaveChip member={member} />
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field title={t('settings.pipeline.fields.gate')}>
          {conditions.length === 0 ? (
            <span className={styles.muted}>{t('settings.pipeline.noGate')}</span>
          ) : (
            <ul className={styles.list}>
              {conditions.map((condition) => (
                <li key={`${condition.type}:${condition.label}:${condition.when ?? ''}`}>
                  {gateConditionText(condition, labels)}
                </li>
              ))}
            </ul>
          )}
        </Field>
      </dl>
      {cards === null ? null : (
        <p className={styles.cards}>
          {cards === 0 ? t('settings.pipeline.cardsNone') : t('settings.pipeline.cards', { count: cards })}
        </p>
      )}
      <p className={styles.id}>
        {t('settings.pipeline.id')} <code>{stage.id}</code>
      </p>
      <Note canEdit={canEdit} />
    </>
  );
}

function ColumnDetail({
  config,
  map,
  columnId,
  canEdit,
  onSelect,
}: {
  config: ProjectConfig;
  map: TeamMap;
  columnId: string;
  canEdit: boolean;
  onSelect(show: SettingsShow): void;
}) {
  const column = config.pipeline.columns.find((candidate) => candidate.id === columnId)!;
  const color = columnColor(config.pipeline, column);
  const stages = map.stages.filter((entry) => entry.stage.columnId === columnId);
  return (
    <>
      <dl className={styles.fields}>
        <Field title={t('settings.pipeline.fields.color')}>
          <span className={styles.person}>
            <span className={styles.swatch} style={{ background: `var(--column-${color}-fg)` }} />
            {t(`columnColors.${color}`)}
          </span>
        </Field>
        <Field title={t('settings.pipeline.fields.stages')}>
          {stages.length === 0 ? (
            <span className={styles.muted}>{t('settings.pipeline.noStages')}</span>
          ) : (
            <ul className={styles.list}>
              {stages.map((entry) => (
                <li key={entry.stage.id}>
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => onSelect({ type: 'stage', id: entry.stage.id })}
                  >
                    {entry.stage.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Field>
      </dl>
      <p className={styles.id}>
        {t('settings.pipeline.id')} <code>{column.id}</code>
      </p>
      <Note canEdit={canEdit} />
    </>
  );
}

/** What the marks of the path mean: the same words as the legend of "Hogyan dolgozunk". */
function PipelineLegend() {
  return (
    <ul className={styles.legend}>
      {STAGE_KINDS.map((kind) => (
        <li key={kind}>
          <span className={styles.legendMark}>
            <StageGlyph kind={kind} size={16} />
          </span>
          {t(`howWeWork.legend.${kind}`)}
        </li>
      ))}
      <li>
        <span className={styles.legendMark}>
          <Icon name="lock" size={14} />
        </span>
        {t('howWeWork.legend.gate')}
      </li>
      <li>
        <span className={styles.legendMark}>
          <span className={styles.dashed}>{t('howWeWork.legend.conditionalSample')}</span>
        </span>
        {t('howWeWork.legend.conditional')}
      </li>
      <li>
        <span className={styles.legendMark}>
          <Icon name="user" size={14} />
        </span>
        {t('howWeWork.legend.human')}
      </li>
      <li>
        <span className={styles.legendMark}>
          <Icon name="undo" size={14} />
        </span>
        {t('howWeWork.legend.loop')}
      </li>
      <li>{t('howWeWork.legend.shapes')}</li>
    </ul>
  );
}

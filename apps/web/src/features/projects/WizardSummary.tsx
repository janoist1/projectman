import type { ReactNode } from 'react';
import { cardMoverHandle, cardMoverOf, isHandOnMove, teamMap } from '@projectman/shared';
import type { MemberConfig, ProjectConfig, ProjectPreview, TeamMapStage } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { Chip } from '../../components/Chip';
import { rich } from '../../i18n/rich';
import { t } from '../../i18n/t';
import { issueMessage } from '../../lib/configIssues';
import { memberLike } from '../how-we-work/MapContext';
import { stageColumns } from '../how-we-work/model';
import { stepForIssue } from './projectForm';
import type { WizardStep } from './projectForm';
import styles from './CreateProjectPage.module.css';

type Issue = ProjectPreview['issues'][number];

/** The issues that stop a project from working: warnings (a leave, a note) never do. */
export const blockingIssues = (issues: readonly Issue[]): Issue[] =>
  issues.filter((issue) => issue.severity !== 'warning');

/** Which stage an issue is about, by its path (`pipeline.stages[3]…`), so the list can name it. */
function stageNameOf(config: ProjectConfig, path: string): string | null {
  const index = /^pipeline\.stages\[(\d+)\]/.exec(path)?.[1];
  return index === undefined ? null : (config.pipeline.stages[Number(index)]?.name ?? null);
}

/** Who carries the card on out of a stage, in words; null where the card does not move on by hand. */
function moverWords(config: ProjectConfig, entry: TeamMapStage): string | null {
  if (!entry.nextStageId || !isHandOnMove(config, entry.stage.id, entry.nextStageId)) return null;
  const mover = cardMoverOf(config);
  if (mover.kind === 'worker') return t('projects.create.movedBy.worker');
  if (mover.kind === 'human') return t('projects.create.movedBy.creator');
  const handle = cardMoverHandle(config);
  const name = config.team.members.find((member) => member.handle === handle)?.displayName;
  return name ? t('projects.create.movedBy.project_manager', { name }) : null;
}

function People({ people }: { people: readonly MemberConfig[] }) {
  if (people.length === 0) return <span>{t('projects.create.nobodyWorks')}</span>;
  return (
    <>
      {people.map((person, index) => (
        <span key={person.handle} className={styles.person}>
          <Avatar member={memberLike(person)} size="xs" />
          {person.displayName}
          {index < people.length - 1 ? ',' : ''}
        </span>
      ))}
    </>
  );
}

function StageLine({
  config,
  entry,
  showName,
  labelsById,
  humanLabels,
}: {
  config: ProjectConfig;
  entry: TeamMapStage;
  showName: boolean;
  labelsById: ReadonlyMap<string, string>;
  humanLabels: ReadonlySet<string>;
}) {
  const people = entry.owners.flatMap((handle) => {
    const member = config.team.members.find((candidate) => candidate.handle === handle);
    return member ? [member] : [];
  });
  const moved = moverWords(config, entry);
  const next = config.pipeline.stages.find((stage) => stage.id === entry.nextStageId);
  const needs = (next?.gate?.conditions ?? []).filter((condition) => condition.type === 'has_label');
  return (
    <li className={styles.stageLine}>
      {showName ? <b className={styles.stageName}>{entry.stage.name}</b> : null}
      <span>
        <People people={people} />
      </span>
      {moved ? <span className={styles.moved}>→ {moved}</span> : null}
      {needs.length > 0 ? (
        <span className={styles.needs}>
          {t('projects.create.needs')}
          {needs.map((condition) => (
            <Chip
              key={`${condition.label}:${condition.when ?? ''}`}
              tone={humanLabels.has(condition.label) ? 'needs' : 'neutral'}
            >
              {labelsById.get(condition.label) ?? condition.label}
            </Chip>
          ))}
        </span>
      ) : null}
    </li>
  );
}

/** "How a card goes": column by column who works on it, who carries it on and what it needs; then whether it works. */
export function WizardSummary({
  preview,
  moverKind,
  onFix,
}: {
  preview: ProjectPreview;
  moverKind: 'worker' | 'project_manager' | 'human';
  onFix: (step: WizardStep) => void;
}) {
  const { config, issues } = preview;
  const map = teamMap(config);
  const columns = stageColumns(map, config.pipeline.columns);
  const labelsById = new Map(config.pipeline.labels.map((label) => [label.id, label.name]));
  const humanLabels = new Set(map.labels.filter((entry) => entry.approval).map((entry) => entry.label.id));
  const problems = blockingIssues(issues);
  const managerName = config.team.members.find(
    (member) => member.handle === cardMoverHandle(config),
  )?.displayName;
  const moverLine: ReactNode =
    moverKind === 'worker'
      ? rich('projects.create.summaryMover.worker', {})
      : moverKind === 'human'
        ? rich('projects.create.summaryMover.creator', {})
        : rich('projects.create.summaryMover.project_manager', { name: managerName ?? '' });
  return (
    <div className={styles.summary}>
      <p className={styles.moverLine}>{moverLine}</p>
      <ol className={styles.columns}>
        {columns.map(({ column, color, stages }) => (
          <li
            key={`${column.id}:${stages[0]?.stage.id}`}
            className={styles.columnRow}
            style={
              {
                '--col-bg': `var(--column-${color}-bg)`,
                '--col-fg': `var(--column-${color}-fg)`,
              } as never
            }
          >
            <span className={styles.columnTag}>{column.name}</span>
            <ul className={styles.stageLines}>
              {stages.map((entry) => (
                <StageLine
                  key={entry.stage.id}
                  config={config}
                  entry={entry}
                  showName={stages.length > 1 || entry.stage.name !== column.name}
                  labelsById={labelsById}
                  humanLabels={humanLabels}
                />
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {problems.length === 0 ? (
        <p className={styles.checkOk} role="status">
          {rich('projects.create.checkOk', {})}
        </p>
      ) : (
        <div className={styles.checkBad} role="alert">
          <b>{t('projects.create.checkBad')}</b>
          <ul>
            {problems.map((issue, index) => {
              const step = stepForIssue(issue.path);
              const stageName = stageNameOf(config, issue.path);
              return (
                <li key={`${issue.code}:${issue.path}:${index}`}>
                  {stageName ? `${stageName}: ` : null}
                  {issueMessage(issue)}{' '}
                  <button type="button" className={styles.fixLink} onClick={() => onFix(step)}>
                    {step === 'kind'
                      ? t('projects.create.fixKind')
                      : step === 'code'
                        ? t('projects.create.fixCode')
                        : t('projects.create.fixMover')}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The project's kind as the summary's subtitle: "Kis csapat · Acme (AC)". */
export function summarySubtitle(kind: string, name: string, key: string): string {
  return t('projects.create.summaryKind', { kind, name, key });
}

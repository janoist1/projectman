import { useEffect, useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { DUTY_IDS, dutyMembers, isOnLeave, StageKind, teamMap } from '@projectman/shared';
import type { DutyId, GateCondition, ProjectConfig, Stage } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { StageGlyph } from '../../../components/flow/StageGlyph';
import { Icon } from '../../../components/Icon';
import { LeaveChip } from '../../../components/LeaveChip';
import { t } from '../../../i18n/t';
import { issueMessage } from '../../../lib/configIssues';
import type { IssueRef } from '../../../lib/configIssues';
import { labelName } from '../../../lib/labels';
import { labelViews } from '../../how-we-work/model';
import { DetailPanel, MissingSettingsElement } from '../DetailPanel';
import { FieldErrors } from '../edit/FieldErrors';
import type { FieldIssue } from '../edit/FieldErrors';
import { useElementEdit } from '../edit/useElementEdit';
import { useLeaveGuard } from '../edit/useLeaveGuard';
import { issueTarget } from '../issueTarget';
import { GateEditor } from './GateEditor';
import { MemberAvatar, MemberPicker } from './MemberPicker';
import styles from './StagePanel.module.css';

/** What the panel edits: the stage, with both ways of choosing owners kept while the draft is open. */
interface StageDraft {
  id: string;
  name: string;
  description: string;
  kind: StageKind;
  columnId: string;
  duty: DutyId | null;
  ownersMode: 'duty' | 'names';
  members: string[];
  conditions: GateCondition[];
}

function draftOf(stage: Stage): StageDraft {
  return {
    id: stage.id,
    name: stage.name,
    description: stage.description ?? '',
    kind: stage.kind,
    columnId: stage.columnId,
    duty: stage.duty ?? null,
    ownersMode: stage.owners !== undefined || !stage.duty ? 'names' : 'duty',
    members: stage.owners ?? [],
    conditions: stage.gate?.conditions.map((condition) => ({ ...condition })) ?? [],
  };
}

function stageOf(draft: StageDraft): Stage {
  const stage: Stage = {
    id: draft.id,
    name: draft.name.trim(),
    kind: draft.kind,
    columnId: draft.columnId,
  };
  if (draft.description.trim()) stage.description = draft.description;
  if (draft.duty) stage.duty = draft.duty;
  // Only the chosen way is saved; without a duty, nobody chosen is the same as no list.
  if (draft.ownersMode === 'names' && (draft.members.length > 0 || draft.duty)) stage.owners = draft.members;
  if (draft.conditions.length > 0) stage.gate = { conditions: draft.conditions };
  return stage;
}

function applyDraft(config: ProjectConfig, draft: StageDraft): ProjectConfig {
  return {
    ...config,
    pipeline: {
      ...config.pipeline,
      stages: config.pipeline.stages.map((stage) => (stage.id === draft.id ? stageOf(draft) : stage)),
    },
  };
}

/** The errors of a draft sorted by the field they belong to; the rest has no field of its own. */
function sortIssues(
  issues: readonly IssueRef[],
  config: ProjectConfig,
  draft: StageDraft,
): { fields: Map<string, FieldIssue[]>; other: FieldIssue[] } {
  const fields = new Map<string, FieldIssue[]>();
  const other: FieldIssue[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const id = `${issue.code}:${issue.path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const target = issueTarget(issue.path, config);
    const mine = target?.show?.type === 'stage' && target.show.id === draft.id;
    let field: string | null = null;
    let message = issueMessage(issue);
    if (mine) {
      const part = target?.field;
      if (part === undefined)
        field =
          issue.code === 'first_stage_not_queue' || issue.code === 'last_stage_not_done' ? 'kind' : null;
      else if (part === 'name') {
        field = 'name';
        if (draft.name.trim() === '') message = t('settings.pipeline.edit.nameRequired');
      } else if (part === 'kind' || part === 'duty' || part === 'description') field = part;
      else if (part === 'columnId') field = 'column';
      else if (part === 'owners' || part.startsWith('owners.')) field = 'owners';
      else {
        const row = /^gate\.conditions\.(\d+)(?:\.(label|when|type))?$/.exec(part);
        if (row) {
          field = `gate:${row[1]}`;
          const condition = draft.conditions[Number(row[1])];
          if (row[2] === 'label' && condition?.label === '')
            message = t('settings.pipeline.edit.labelRequired');
          if (row[2] === 'when' && condition?.when === '') message = t('settings.pipeline.edit.whenRequired');
        } else if (part.startsWith('gate')) field = 'gate';
      }
    }
    const entry = { message, code: issue.code, path: issue.path };
    if (field === null) other.push(entry);
    else fields.set(field, [...(fields.get(field) ?? []), entry]);
  }
  return { fields, other };
}

/** "Anna, Béla és Cecil" / "Anna és még 3". */
function namesText(names: readonly string[]): string {
  if (names.length > 3)
    return t('howWeWork.flow.ownersMore', {
      names: names.slice(0, 2).join(t('common.listSeparator')),
      count: names.length - 2,
    });
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(t('common.listSeparator'))}${t('common.and')}${names[names.length - 1]}`;
}

interface StagePanelProps {
  config: ProjectConfig;
  stageId: string;
  /** The cards in the stage, or null while the board is not known. */
  cards: number | null;
  back?: ReactNode;
  empty: ReactNode;
  onClose(): void;
  /** A save or an undo went through: the stage's row marks the moment. */
  onSaved(stageId: string): void;
}

/** The stage's details as a form: one stage saved on its own, with its conflicts, undo and unsaved-change guard. */
export function StagePanel({ config, stageId, cards, back, empty, onClose, onSaved }: StagePanelProps) {
  const { isOwner } = useProject();
  const formId = useId();
  const edit = useElementEdit<StageDraft>({
    key: `stage:${stageId}`,
    initial: (current) => {
      const stage = current.pipeline.stages.find((candidate) => candidate.id === stageId);
      return stage ? draftOf(stage) : null;
    },
    apply: applyDraft,
    toPatch: (candidate) => ({ pipeline: candidate.pipeline }),
    savedText: (draft) => t('settings.pipeline.edit.saved', { name: draft.name.trim() }),
    name: (draft) => draft.name.trim(),
  });
  const saved = config.pipeline.stages.find((stage) => stage.id === stageId);
  const savedIndex = config.pipeline.stages.findIndex((stage) => stage.id === stageId);
  const draft = edit.draft;
  useLeaveGuard(edit.dirty, edit.discard, draft?.name.trim() || saved?.name || '');
  const saves = edit.saves;
  useEffect(() => {
    if (saves > 0) onSaved(stageId);
  }, [saves]);

  const map = useMemo(() => teamMap(config), [config]);
  const views = useMemo(() => labelViews(map), [map]);
  const dutyHolders = useMemo(
    () => (draft?.duty ? dutyMembers(config, draft.duty) : []),
    [config, draft?.duty],
  );
  const sorted = useMemo(() => {
    if (!edit.candidate || !draft) return null;
    const failed = edit.failure?.kind === 'issues' ? edit.failure.issues : [];
    return sortIssues([...edit.errors, ...failed], edit.candidate, draft);
  }, [edit.candidate, edit.errors, edit.failure, draft]);

  if (!draft)
    return (
      <DetailPanel open itemKey="gone" title={t('howWeWork.gone.title')} empty={empty} onClose={onClose}>
        <MissingSettingsElement onClose={onClose} />
      </DetailPanel>
    );

  const update = (change: Partial<StageDraft>) => edit.setDraft({ ...draft, ...change });
  const issuesAt = (field: string) => sorted?.fields.get(field) ?? [];
  const errorId = (field: string) => `${formId}-${field}-errors`;
  /** The error sentence under a field names it for assistive technology. */
  const describedBy = (field: string) => (issuesAt(field).length > 0 ? errorId(field) : undefined);
  const invalid = (field: string) => issuesAt(field).length > 0;
  const members = new Map(config.team.members.map((member) => [member.handle, member]));
  const chosen = draft.members.flatMap((handle) => {
    const member = members.get(handle);
    return member ? [member] : [];
  });
  const carried = draft.kind === 'work' || draft.kind === 'step' || draft.kind === 'release';
  const nobody = carried && (draft.ownersMode === 'duty' ? dutyHolders : chosen).length === 0;
  const stillFree = config.team.members.filter((member) => !draft.members.includes(member.handle));
  const kindLocked =
    saved !== undefined &&
    ((savedIndex === 0 && saved.kind === 'queue') ||
      (savedIndex === config.pipeline.stages.length - 1 && saved.kind === 'done'));
  const kindLockText =
    savedIndex === 0 ? t('settings.pipeline.edit.kindFirst') : t('settings.pipeline.edit.kindLast');
  const disabled = edit.saving || edit.gone;
  const canSave = edit.dirty && edit.errors.length === 0 && edit.locked.length === 0 && !edit.gone;
  const stoppable = map.blockingLabels.map((id) => labelName(id, views));
  const conflictAuthor = edit.conflict
    ? (members.get(edit.conflict.author)?.displayName ?? edit.conflict.author)
    : '';
  const failureReason =
    edit.failure?.kind === 'error' && edit.failure.reason
      ? t('settings.pipeline.edit.failed', { reason: edit.failure.reason })
      : null;
  const otherIssues = sorted?.other ?? [];

  let band: ReactNode = null;
  if (edit.gone)
    band = (
      <p className={clsx(styles.band, styles.warning)} role="status">
        {t('settings.pipeline.edit.gone')}
      </p>
    );
  else if (edit.conflict)
    band = (
      <p className={clsx(styles.band, styles.warning)} role="status">
        {t('settings.pipeline.edit.conflict', { name: conflictAuthor })}
      </p>
    );
  else if (edit.failure?.kind === 'owner_only')
    band = (
      <p className={clsx(styles.band, styles.danger)} role="alert">
        {t('settings.pipeline.edit.ownerOnly')}
      </p>
    );
  else if (edit.failure?.kind === 'error')
    band = (
      <p className={clsx(styles.band, styles.danger)} role="alert">
        {failureReason ?? t('settings.pipeline.edit.failedNetwork')}
      </p>
    );
  else if (otherIssues.length > 0)
    band = (
      <div className={clsx(styles.band, styles.danger)} role="alert">
        <p>
          {t('settings.pipeline.edit.failed', {
            reason: otherIssues.map((issue) => issue.message).join(' '),
          })}
        </p>
        <details>
          <summary>{t('settings.pipeline.edit.details')}</summary>
          {otherIssues.map((issue) => (
            <code key={`${issue.code}:${issue.path}`}>
              {issue.code} · {issue.path}
            </code>
          ))}
        </details>
      </div>
    );

  const footer = edit.gone ? (
    <div className={styles.footer}>
      <Button variant="secondary" onClick={onClose}>
        {t('settings.pipeline.edit.goneClose')}
      </Button>
    </div>
  ) : (
    <div className={styles.footer}>
      <div className={styles.status}>
        {edit.dirty ? (
          <span className={styles.unsaved}>
            <span aria-hidden="true">●</span> {t('settings.pipeline.edit.unsaved')}
          </span>
        ) : null}
        {edit.locked.length > 0 ? (
          <span className={styles.hint}>{t('settings.edit.approvalOwnerOnly')}</span>
        ) : edit.errors.length > 0 ? (
          <span className={styles.hint}>{t('settings.pipeline.edit.fixFirst')}</span>
        ) : null}
      </div>
      <div className={styles.buttons}>
        <Button type="submit" form={formId} variant="primary" disabled={!canSave} loading={edit.saving}>
          {edit.saving ? t('settings.pipeline.edit.saving') : t('settings.pipeline.edit.save')}
        </Button>
        <Button variant="secondary" disabled={!edit.dirty || edit.saving} onClick={edit.discard}>
          {t('settings.pipeline.edit.cancel')}
        </Button>
      </div>
    </div>
  );

  return (
    <DetailPanel
      open
      itemKey={`stage:${stageId}`}
      focusSignal={edit.saves}
      kicker={t('settings.pipeline.kickerStage', { kind: t(`stageKinds.${draft.kind}`) })}
      title={saved?.name ?? draft.name}
      back={back}
      empty={empty}
      footer={footer}
      onClose={onClose}
    >
      {band}
      <form
        id={formId}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) void edit.save();
        }}
      >
        <fieldset className={styles.fields} disabled={disabled}>
          <div className={styles.field}>
            <label htmlFor={`${formId}-name`}>{t('settings.pipeline.edit.name')}</label>
            <input
              id={`${formId}-name`}
              value={draft.name}
              required
              aria-invalid={invalid('name')}
              aria-describedby={describedBy('name')}
              onChange={(event) => update({ name: event.target.value })}
            />
            <FieldErrors id={errorId('name')} issues={issuesAt('name')} />
          </div>

          <div className={styles.field}>
            <label htmlFor={`${formId}-description`}>{t('settings.edit.description')}</label>
            <textarea
              id={`${formId}-description`}
              value={draft.description}
              onChange={(event) => update({ description: event.target.value })}
            />
          </div>

          <fieldset
            className={styles.group}
            disabled={disabled || kindLocked}
            aria-describedby={describedBy('kind')}
          >
            <legend>{t('settings.pipeline.edit.kind')}</legend>
            {StageKind.options.map((kind) => (
              <label key={kind} className={clsx(styles.radio, draft.kind === kind && styles.picked)}>
                <input
                  type="radio"
                  name={`${formId}-kind`}
                  value={kind}
                  checked={draft.kind === kind}
                  onChange={() => update({ kind })}
                />
                <StageGlyph kind={kind} size={16} />
                {t(`stageKinds.${kind}`)}
              </label>
            ))}
            <p className={styles.hintText}>{t(`howWeWork.kindHints.${draft.kind}`)}</p>
            {kindLocked ? (
              <p className={styles.lockText}>
                <Icon name="lock" size={13} /> {kindLockText}
              </p>
            ) : null}
            <FieldErrors id={errorId('kind')} issues={issuesAt('kind')} />
          </fieldset>

          <div className={styles.field}>
            <label htmlFor={`${formId}-column`}>{t('settings.pipeline.fields.column')}</label>
            <select
              id={`${formId}-column`}
              value={draft.columnId}
              aria-invalid={invalid('column')}
              aria-describedby={describedBy('column')}
              onChange={(event) => update({ columnId: event.target.value })}
            >
              {config.pipeline.columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
            <FieldErrors id={errorId('column')} issues={issuesAt('column')} />
          </div>

          <div className={styles.field}>
            <label htmlFor={`${formId}-duty`}>{t('settings.pipeline.fields.duty')}</label>
            <select
              id={`${formId}-duty`}
              value={draft.duty ?? ''}
              aria-invalid={invalid('duty')}
              aria-describedby={describedBy('duty')}
              onChange={(event) => {
                const duty = event.target.value ? (event.target.value as DutyId) : null;
                update({ duty, ownersMode: duty ? draft.ownersMode : 'names' });
              }}
            >
              <option value="">{t('settings.pipeline.edit.dutyNone')}</option>
              {DUTY_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`dutyNames.${id}`)}
                </option>
              ))}
            </select>
            <FieldErrors id={errorId('duty')} issues={issuesAt('duty')} />
          </div>

          <fieldset className={styles.group} aria-describedby={describedBy('owners')}>
            <legend>{t('settings.pipeline.fields.owners')}</legend>
            <label className={styles.radio}>
              <input
                type="radio"
                name={`${formId}-owners`}
                checked={draft.ownersMode === 'duty'}
                disabled={!draft.duty}
                onChange={() => update({ ownersMode: 'duty' })}
              />
              <span>
                {t('settings.pipeline.edit.ownersByDuty', {
                  names:
                    dutyHolders.length > 0
                      ? namesText(dutyHolders.map((member) => member.displayName))
                      : t('settings.pipeline.edit.ownersNobody'),
                })}
              </span>
            </label>
            {draft.duty ? null : (
              <p className={styles.hintText}>{t('settings.pipeline.edit.ownersNeedDuty')}</p>
            )}
            <label className={styles.radio}>
              <input
                type="radio"
                name={`${formId}-owners`}
                checked={draft.ownersMode === 'names'}
                onChange={() => update({ ownersMode: 'names' })}
              />
              {t('settings.pipeline.edit.ownersByName')}
            </label>
            {draft.ownersMode === 'names' ? (
              <div className={styles.members}>
                {chosen.length > 0 ? (
                  <ul className={styles.chips}>
                    {chosen.map((member) => (
                      <li
                        key={member.handle}
                        className={clsx(styles.chip, isOnLeave(member) && styles.onLeave)}
                      >
                        <MemberAvatar member={member} />
                        <span>{member.displayName}</span>
                        <LeaveChip member={member} />
                        <button
                          type="button"
                          className={styles.chipRemove}
                          aria-label={t('settings.pipeline.edit.removeMember', { name: member.displayName })}
                          onClick={() =>
                            update({ members: draft.members.filter((handle) => handle !== member.handle) })
                          }
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <MemberPicker
                  candidates={stillFree}
                  disabled={disabled}
                  onAdd={(handle) => update({ members: [...draft.members, handle] })}
                />
              </div>
            ) : null}
            {nobody ? (
              <p className={styles.lockText}>
                <Icon name="exclamation" size={13} /> {t('howWeWork.flow.noOwner')}
              </p>
            ) : null}
            <FieldErrors id={errorId('owners')} issues={issuesAt('owners')} />
          </fieldset>

          <GateEditor
            stageKind={draft.kind}
            conditions={draft.conditions}
            labels={config.pipeline.labels}
            isOwner={isOwner}
            disabled={disabled}
            rowIssues={(index) => issuesAt(`gate:${index}`)}
            gateIssues={issuesAt('gate')}
            onChange={(conditions) => update({ conditions })}
          />
          {stoppable.length > 0 ? (
            <p className={styles.hintText}>
              {t('howWeWork.flow.stoppableText', { labels: stoppable.join(t('common.listSeparator')) })}
            </p>
          ) : null}
        </fieldset>
      </form>
      {cards === null ? null : (
        <p className={styles.cards}>
          {cards === 0 ? t('settings.pipeline.cardsNone') : t('settings.pipeline.cards', { count: cards })}
        </p>
      )}
      <p className={styles.id}>
        {t('settings.pipeline.id')} <code>{draft.id}</code>
      </p>
    </DetailPanel>
  );
}

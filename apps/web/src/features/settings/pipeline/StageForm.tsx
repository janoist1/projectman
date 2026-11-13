import { useMemo } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { DUTY_IDS, dutyMembers, isOnLeave, StageKind, teamMap } from '@projectman/shared';
import type { DutyId, ProjectConfig } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { StageGlyph } from '../../../components/flow/StageGlyph';
import { Icon } from '../../../components/Icon';
import { LeaveChip } from '../../../components/LeaveChip';
import { t } from '../../../i18n/t';
import { labelName } from '../../../lib/labels';
import { labelViews } from '../../how-we-work/model';
import { FieldErrors } from '../edit/FieldErrors';
import type { FieldIssue } from '../edit/FieldErrors';
import { GateEditor } from './GateEditor';
import { MemberAvatar, MemberPicker } from './MemberPicker';
import { SmallCardsBlock } from './SmallCardsBlock';
import { NEW_COLUMN, namesText } from './stageDraft';
import type { StageDraft } from './stageDraft';
import styles from './StagePanel.module.css';

interface StageFormProps {
  formId: string;
  config: ProjectConfig;
  draft: StageDraft;
  update(change: Partial<StageDraft>): void;
  disabled: boolean;
  issuesAt(field: string): readonly FieldIssue[];
  onSubmit(): void;
  /** The description is a field of a saved stage; a new one has none. */
  withDescription?: boolean;
  /** Under the name: the new stage's identifier preview. */
  nameNote?: ReactNode;
  /** Between the name and the kind: where the new stage goes. */
  place?: ReactNode;
  /** The name of what a new column would be called; offers "Új oszlop: {name}" among the columns. */
  newColumnName?: string;
  /** Why the kind cannot change (the first and the last stage), else null. */
  kindLock?: string | null;
  /** Under the column: the identifier preview of a new column. */
  columnNote?: ReactNode;
  /** The small-card rule is a block of a saved step stage; a new stage has none yet. */
  withSmallCards?: boolean;
}

/** The fields of one stage, in the order of the design; the panel of a saved stage and of a new one share them. */
export function StageForm({
  formId,
  config,
  draft,
  update,
  disabled,
  issuesAt,
  onSubmit,
  withDescription,
  nameNote,
  place,
  newColumnName,
  kindLock = null,
  columnNote,
  withSmallCards = false,
}: StageFormProps) {
  const { isOwner } = useProject();
  const map = useMemo(() => teamMap(config), [config]);
  const views = useMemo(() => labelViews(map), [map]);
  const dutyHolders = useMemo(
    () => (draft.duty ? dutyMembers(config, draft.duty) : []),
    [config, draft.duty],
  );
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
  const stoppable = map.blockingLabels.map((id) => labelName(id, views));

  return (
    <form
      id={formId}
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
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
          {nameNote}
          <FieldErrors id={errorId('name')} issues={issuesAt('name')} />
        </div>

        {place}

        {withDescription ? (
          <div className={styles.field}>
            <label htmlFor={`${formId}-description`}>{t('settings.edit.description')}</label>
            <textarea
              id={`${formId}-description`}
              value={draft.description}
              onChange={(event) => update({ description: event.target.value })}
            />
          </div>
        ) : null}

        <fieldset
          className={styles.group}
          disabled={disabled || kindLock !== null}
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
          {kindLock !== null ? (
            <p className={styles.lockText}>
              <Icon name="lock" size={13} /> {kindLock}
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
            {newColumnName === undefined ? null : (
              <option value={NEW_COLUMN}>
                {newColumnName.trim()
                  ? t('settings.pipeline.new.newColumn', { name: newColumnName.trim() })
                  : t('settings.pipeline.new.newColumnBlank')}
              </option>
            )}
          </select>
          {columnNote}
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
          {nobody && issuesAt('owners').length === 0 ? (
            <p className={styles.lockText}>
              <Icon name="exclamation" size={13} /> {t('howWeWork.flow.noOwner')}
            </p>
          ) : null}
          <FieldErrors id={errorId('owners')} issues={issuesAt('owners')} />
        </fieldset>

        {withSmallCards && draft.kind === 'step' ? (
          <SmallCardsBlock
            formId={formId}
            config={config}
            draft={draft}
            update={update}
            disabled={disabled}
            issuesAt={issuesAt}
            stageOwnerNames={(draft.ownersMode === 'duty' ? dutyHolders : chosen).map(
              (member) => member.displayName,
            )}
          />
        ) : null}

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
  );
}

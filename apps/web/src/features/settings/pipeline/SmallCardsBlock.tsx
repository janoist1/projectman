import { useMemo } from 'react';
import clsx from 'clsx';
import { isOnLeave, smallCardsWarnings } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { Link } from 'react-router';
import { useProject } from '../../../app/contexts';
import { Icon } from '../../../components/Icon';
import { LeaveChip } from '../../../components/LeaveChip';
import { joinNames, t } from '../../../i18n/t';
import { FieldErrors } from '../edit/FieldErrors';
import { showParams } from '../selection';
import type { FieldIssue } from '../edit/FieldErrors';
import { MemberAvatar, MemberPicker } from './MemberPicker';
import { SMALL_CARD_POINTS, stageOf } from './stageDraft';
import type { StageDraft } from './stageDraft';
import panel from './StagePanel.module.css';
import styles from './SmallCardsBlock.module.css';

interface SmallCardsBlockProps {
  formId: string;
  config: ProjectConfig;
  draft: StageDraft;
  update(change: Partial<StageDraft>): void;
  disabled: boolean;
  issuesAt(field: string): readonly FieldIssue[];
  /** The names of the handlers the stage's own owners give ("Every other card → …"). */
  stageOwnerNames: readonly string[];
}

/**
 * The small-card rule of a step stage (PM-1378): the switch, the points limit, who carries the small cards and the
 * central files that keep a card with the stage's own owners; a live summary says what the rule does as it is.
 */
export function SmallCardsBlock({
  formId,
  config,
  draft,
  update,
  disabled,
  issuesAt,
  stageOwnerNames,
}: SmallCardsBlockProps) {
  const { key } = useProject();
  const members = new Map(config.team.members.map((member) => [member.handle, member]));
  const chosen = draft.smallOwners.flatMap((handle) => {
    const member = members.get(handle);
    return member ? [member] : [];
  });
  const stillFree = config.team.members.filter((member) => !draft.smallOwners.includes(member.handle));
  const ownersId = `${formId}-smallOwners-errors`;
  const pathsId = `${formId}-smallPaths-errors`;
  const ownersInvalid = issuesAt('smallOwners').length > 0;
  const pathsInvalid = issuesAt('smallPaths').length > 0;

  // The warnings read the stage as the form holds it, not as it is saved.
  const warnings = useMemo(() => {
    if (!draft.smallEnabled) return [];
    const stage = stageOf(draft);
    const stages = config.pipeline.stages.map((candidate) => (candidate.id === draft.id ? stage : candidate));
    return smallCardsWarnings({ team: config.team, pipeline: { ...config.pipeline, stages } }, stage);
  }, [config, draft]);
  const nameOf = (handle: string) => members.get(handle)?.displayName ?? handle;
  const labelNameOf = (id: string) => config.pipeline.labels.find((label) => label.id === id)?.name ?? id;

  const small = joinNames(chosen.map((member) => member.displayName));
  const others =
    stageOwnerNames.length > 0 ? joinNames([...stageOwnerNames]) : t('settings.pipeline.edit.ownersNobody');

  return (
    <div className={styles.block} role="group" aria-label={t('settings.pipeline.edit.smallRule.group')}>
      <label className={panel.radio}>
        <input
          type="checkbox"
          checked={draft.smallEnabled}
          onChange={(event) => update({ smallEnabled: event.target.checked })}
        />
        {t('settings.pipeline.edit.smallRule.toggle')}
      </label>
      <p className={panel.hintText}>{t('settings.pipeline.edit.smallRule.intro')}</p>
      {draft.smallEnabled ? (
        <div className={styles.body}>
          <div className={styles.points}>
            <label htmlFor={`${formId}-smallPoints`}>
              {t('settings.pipeline.edit.smallRule.pointsBefore')}
            </label>
            <select
              id={`${formId}-smallPoints`}
              value={draft.smallPoints}
              onChange={(event) =>
                update({ smallPoints: Number(event.target.value) as StageDraft['smallPoints'] })
              }
            >
              {SMALL_CARD_POINTS.map((points) => (
                <option key={points} value={points}>
                  {points}
                </option>
              ))}
            </select>
            <span>{t('settings.pipeline.edit.smallRule.pointsAfter')}</span>
          </div>

          <fieldset className={panel.group} aria-describedby={ownersInvalid ? ownersId : undefined}>
            <legend>{t('settings.pipeline.edit.smallRule.owners')}</legend>
            <div className={panel.members}>
              {chosen.length > 0 ? (
                <ul className={panel.chips}>
                  {chosen.map((member) => (
                    <li key={member.handle} className={clsx(panel.chip, isOnLeave(member) && panel.onLeave)}>
                      <MemberAvatar member={member} />
                      <span>{member.displayName}</span>
                      <LeaveChip member={member} />
                      <button
                        type="button"
                        className={panel.chipRemove}
                        aria-label={t('settings.pipeline.edit.removeMember', { name: member.displayName })}
                        onClick={() =>
                          update({
                            smallOwners: draft.smallOwners.filter((handle) => handle !== member.handle),
                          })
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
                onAdd={(handle) => update({ smallOwners: [...draft.smallOwners, handle] })}
              />
            </div>
            <FieldErrors id={ownersId} issues={issuesAt('smallOwners')} />
          </fieldset>

          <div className={panel.field}>
            <label htmlFor={`${formId}-smallPaths`}>{t('settings.pipeline.edit.smallRule.paths')}</label>
            <textarea
              id={`${formId}-smallPaths`}
              className={styles.paths}
              value={draft.smallPaths}
              rows={4}
              spellCheck={false}
              aria-invalid={pathsInvalid}
              aria-describedby={`${formId}-smallPaths-help${pathsInvalid ? ` ${pathsId}` : ''}`}
              onChange={(event) => update({ smallPaths: event.target.value })}
            />
            <p id={`${formId}-smallPaths-help`} className={panel.hintText}>
              {t('settings.pipeline.edit.smallRule.pathsHelp')}
            </p>
            <FieldErrors id={pathsId} issues={issuesAt('smallPaths')} />
          </div>

          <div className={styles.summary} aria-live="polite">
            <p>
              {chosen.length > 0
                ? t('settings.pipeline.edit.smallRule.summarySmall', {
                    points: draft.smallPoints,
                    names: small,
                  })
                : t('settings.pipeline.edit.smallRule.summaryNobody', { points: draft.smallPoints })}
            </p>
            <p>{t('settings.pipeline.edit.smallRule.summaryOthers', { names: others })}</p>
          </div>

          {warnings.length > 0 ? (
            <ul className={styles.warnings}>
              {warnings.map((warning) => (
                <li key={`${warning.code}:${warning.member}:${'label' in warning ? warning.label : ''}`}>
                  <Icon name="exclamation" size={13} />
                  {warning.code === 'on_leave' ? (
                    <span>
                      {t('settings.pipeline.edit.smallRule.warnings.onLeave', {
                        name: nameOf(warning.member),
                      })}{' '}
                      {members.get(warning.member) ? (
                        <LeaveChip member={members.get(warning.member)!} />
                      ) : null}
                    </span>
                  ) : (
                    <span>
                      {t('settings.pipeline.edit.smallRule.warnings.cannotSetLabel', {
                        name: nameOf(warning.member),
                        label: labelNameOf(warning.label),
                      })}{' '}
                      <Link
                        to={`/p/${key}/settings/labels?${showParams({ type: 'label', id: warning.label })}`}
                      >
                        {t('settings.pipeline.edit.smallRule.warnings.labelSetters')}
                      </Link>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          <details className={styles.when}>
            <summary>{t('settings.pipeline.edit.smallRule.whenTitle')}</summary>
            <ul>
              <li>{t('settings.pipeline.edit.smallRule.whenPoints')}</li>
              <li>{t('settings.pipeline.edit.smallRule.whenFiles')}</li>
              <li>{t('settings.pipeline.edit.smallRule.whenAuthor')}</li>
            </ul>
            <p>{t('settings.pipeline.edit.smallRule.whenEntry')}</p>
          </details>
        </div>
      ) : null}
    </div>
  );
}

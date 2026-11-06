import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { canonical, DUTY_IDS, introducedErrors, LabelColor } from '@projectman/shared';
import type { LabelView, ProjectConfig } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { Icon } from '../../../components/Icon';
import { LabelChip } from '../../../components/LabelChip';
import { t } from '../../../i18n/t';
import { issueMessage } from '../../../lib/configIssues';
import type { IssueRef } from '../../../lib/configIssues';
import { DetailPanel, MissingSettingsElement } from '../DetailPanel';
import { EditBand, EditFooter } from '../edit/EditChrome';
import { FieldErrors } from '../edit/FieldErrors';
import type { FieldIssue } from '../edit/FieldErrors';
import { useElementEdit } from '../edit/useElementEdit';
import { useLeaveGuard } from '../edit/useLeaveGuard';
import { issueTarget } from '../issueTarget';
import fields from '../pipeline/StagePanel.module.css';
import { UsageList } from './LabelDetail';
import {
  BLANK_LABEL,
  draftOf,
  isOwnerLocked,
  labelOf,
  labelUsage,
  newLabelId,
  withLabel,
  withNewLabel,
  withoutLabel,
} from './labelDraft';
import type { LabelDraft, SetterMode } from './labelDraft';
import styles from './LabelPanel.module.css';
import { usageStages } from './labelText';
import { SetterList } from './SetterList';

const MODES: readonly SetterMode[] = ['anyone', 'humans', 'system', 'duties', 'members'];
const MEANING_MAX = 500;
const NAME_MAX = 60;

/** The errors of a draft sorted by the field they belong to; the rest has no field of its own. */
function sortIssues(
  issues: readonly IssueRef[],
  candidate: ProjectConfig,
  draft: LabelDraft,
  id: string,
): { fields: Map<string, FieldIssue[]>; other: FieldIssue[] } {
  const sorted = new Map<string, FieldIssue[]>();
  const other: FieldIssue[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const key = `${issue.code}:${issue.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target = issueTarget(issue.path, candidate);
    const mine = target?.show?.type === 'label' && target.show.id === id;
    const part = mine ? target?.field : undefined;
    let field: string | null = null;
    let message = issueMessage(issue);
    if (part === 'name' || part === 'id') {
      field = 'name';
      if (part === 'name' && draft.name.trim() === '') message = t('settings.labels.edit.nameRequired');
    } else if (part === 'meaning' || part === 'color' || part === 'group') field = part;
    else if (part !== undefined && part.startsWith('setBy')) field = 'who';
    const entry = { message, code: issue.code, path: issue.path };
    if (field === null) other.push(entry);
    else sorted.set(field, [...(sorted.get(field) ?? []), entry]);
  }
  return { fields: sorted, other };
}

interface LabelPanelProps {
  config: ProjectConfig;
  /** An existing label, or a new one (with the card tag that has no meaning yet, when it comes from one). */
  show: { type: 'label'; id: string } | { type: 'new-label'; tag?: string };
  empty: ReactNode;
  back?: ReactNode;
  onClose(): void;
  /** A save or an undo went through: the label's row marks the moment. */
  onSaved(id: string): void;
  /** The new label was saved: the selection becomes the label itself. */
  onCreated(id: string): void;
  /** The label was deleted from the panel: the list takes the focus. */
  onRemoved(id: string): void;
}

/** One label as a form: saved on its own, with its conflicts, undo and unsaved-change guard; deletes with a confirmation. */
export function LabelPanel({
  config,
  show,
  empty,
  back,
  onClose,
  onSaved,
  onCreated,
  onRemoved,
}: LabelPanelProps) {
  const { isOwner } = useProject();
  const formId = useId();
  const creating = show.type === 'new-label';
  const tag = show.type === 'new-label' ? show.tag : undefined;
  const labelKey = show.type === 'label' ? show.id : null;
  const edit = useElementEdit<LabelDraft>({
    key: labelKey === null ? `new-label:${tag ?? ''}` : `label:${labelKey}`,
    initial: (current) => {
      if (labelKey === null) return BLANK_LABEL;
      const label = current.pipeline.labels.find((candidate) => candidate.id === labelKey);
      return label ? draftOf(label) : null;
    },
    // A card's tag keeps its text as the id; any other new label takes its id from its name.
    apply: (current, draft) =>
      labelKey === null
        ? withNewLabel(current, draft, tag ?? newLabelId(current, draft.name))
        : withLabel(current, draft, labelKey),
    toPatch: (candidate) => ({ pipeline: candidate.pipeline }),
    savedText: (draft) =>
      t(labelKey === null ? 'settings.labels.edit.created' : 'settings.pipeline.edit.saved', {
        name: draft.name.trim(),
      }),
    name: (draft) => draft.name.trim(),
    without: (current) => (labelKey === null ? current : withoutLabel(current, labelKey)),
    removedText: (draft) => t('settings.labels.edit.removed', { name: draft.name.trim() }),
  });
  const saved = labelKey === null ? undefined : config.pipeline.labels.find((label) => label.id === labelKey);
  const draft = edit.draft;
  const prefilled =
    tag !== undefined && draft !== null && canonical(draft) === canonical({ ...BLANK_LABEL, name: tag });
  useLeaveGuard(edit.dirty && !prefilled, edit.discard, draft?.name.trim() || saved?.name || '');
  const saves = edit.saves;
  useEffect(() => {
    if (saves > 0 && labelKey !== null) onSaved(labelKey);
  }, [saves]);
  // "Jelentés megadása": the tag is the name to begin with, and the draft starts as a change to save.
  useEffect(() => {
    if (tag && edit.draft && canonical(edit.draft) === canonical(BLANK_LABEL))
      edit.setDraft({ ...BLANK_LABEL, name: tag });
  }, [tag]);
  const [confirming, setConfirming] = useState(false);
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    if (removed && !edit.dirty && labelKey !== null) onRemoved(labelKey);
  }, [removed, edit.dirty]);

  const newId = tag ?? (draft ? newLabelId(config, draft.name) : '');
  const id = labelKey ?? newId;
  const sorted = useMemo(() => {
    if (!edit.candidate || !draft) return null;
    const failed = edit.failure?.kind === 'issues' ? edit.failure.issues : [];
    return sortIssues([...edit.errors, ...failed], edit.candidate, draft, id);
  }, [edit.candidate, edit.errors, edit.failure, draft, id]);
  const uses = useMemo(() => (labelKey === null ? [] : labelUsage(config, labelKey)), [config, labelKey]);
  const removeBlock = useMemo(() => {
    if (!saved || labelKey === null) return null;
    if (isOwnerLocked(saved, isOwner)) return t('settings.edit.approvalOwnerOnly');
    if (uses.length > 0)
      return t('settings.labels.edit.removeUsed', {
        stages: usageStages(uses).join(t('common.listSeparator')),
      });
    const [first] = introducedErrors(config, withoutLabel(config, labelKey));
    return first ? t('settings.labels.edit.removeInvalid', { reason: issueMessage(first) }) : null;
  }, [config, saved, labelKey, uses, isOwner]);
  const duties = useMemo(() => DUTY_IDS.map((duty) => ({ value: duty, name: t(`dutyNames.${duty}`) })), []);
  const memberOptions = useMemo(
    () =>
      config.team.members.map((member) => ({
        value: member.handle,
        name: member.displayName,
        hint: member.handle,
      })),
    [config.team.members],
  );

  if (removed) return <DetailPanel open={false} itemKey="removed" title="" empty={empty} onClose={onClose} />;
  if (!draft)
    return (
      <DetailPanel open itemKey="gone" title={t('howWeWork.gone.title')} empty={empty} onClose={onClose}>
        <MissingSettingsElement onClose={onClose} />
      </DetailPanel>
    );

  const update = (change: Partial<LabelDraft>) => edit.setDraft({ ...draft, ...change });
  const issuesAt = (field: string) => sorted?.fields.get(field) ?? [];
  const errorId = (field: string) => `${formId}-${field}-errors`;
  const describedBy = (field: string) => (issuesAt(field).length > 0 ? errorId(field) : undefined);
  const invalid = (field: string) => issuesAt(field).length > 0;
  const ownerLocked = isOwnerLocked(saved, isOwner);
  const disabled = edit.saving || edit.gone;
  const frozen = disabled || ownerLocked;
  const canSave =
    edit.dirty &&
    edit.errors.length === 0 &&
    edit.locked.length === 0 &&
    draft.name.trim() !== '' &&
    !edit.gone &&
    !ownerLocked;
  const members = new Map(config.team.members.map((member) => [member.handle, member]));
  const conflictAuthor = edit.conflict
    ? (members.get(edit.conflict.author)?.displayName ?? edit.conflict.author)
    : '';
  const preview: LabelView = {
    ...labelOf(draft, id || 'label', saved),
    holders: [],
  };
  // An emptied name keeps the chip of the saved label (the field says the name is missing); only a new label has none.
  preview.name = preview.name || saved?.name || t('settings.labels.newName');
  const footer = (
    <EditFooter
      edit={edit}
      formId={formId}
      canSave={canSave}
      saveText={t(creating ? 'settings.labels.edit.create' : 'settings.pipeline.edit.save')}
      onClose={onClose}
    />
  );
  const title =
    saved?.name ??
    (creating ? t(tag ? 'settings.labels.edit.defineTitle' : 'settings.labels.edit.newTitle') : draft.name);
  const mode = draft.mode;
  /** An existing label the system puts on (integrations): who sets it is not for the project to change. */
  const systemOwned = saved?.setBy === 'system';

  return (
    <DetailPanel
      open
      itemKey={labelKey === null ? `new-label:${tag ?? ''}` : `label:${labelKey}`}
      focusSignal={edit.saves}
      kicker={t('settings.labels.edit.kicker')}
      title={title}
      back={back}
      empty={empty}
      footer={footer}
      onClose={onClose}
    >
      <EditBand edit={edit} conflictName={conflictAuthor} other={sorted?.other ?? []} />
      {ownerLocked ? (
        <p className={clsx(fields.lockText, styles.lockSpaced)}>
          <Icon name="lock" size={13} /> {t('settings.edit.approvalOwnerOnly')}
        </p>
      ) : null}
      <form
        id={formId}
        className={fields.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          void edit.save().then((ok) => {
            if (ok && creating) onCreated(id);
          });
        }}
      >
        <fieldset className={fields.fields} disabled={frozen}>
          <div className={styles.preview}>
            <LabelChip id={preview.id} labels={[preview]} />
          </div>

          <div className={fields.field}>
            <label htmlFor={`${formId}-name`}>{t('settings.labels.name')}</label>
            <input
              id={`${formId}-name`}
              value={draft.name}
              required
              maxLength={NAME_MAX}
              aria-invalid={invalid('name')}
              aria-describedby={describedBy('name')}
              onChange={(event) => update({ name: event.target.value })}
            />
            <FieldErrors id={errorId('name')} issues={issuesAt('name')} />
          </div>

          <fieldset className={fields.group} aria-describedby={describedBy('color')}>
            <legend>{t('settings.labels.color')}</legend>
            <div className={styles.colors}>
              {(['', ...LabelColor.options] as const).map((color) => (
                <label
                  key={color || 'none'}
                  className={clsx(styles.color, draft.color === color && fields.picked)}
                >
                  <input
                    type="radio"
                    name={`${formId}-color`}
                    checked={draft.color === color}
                    onChange={() => update({ color })}
                  />
                  <span
                    className={styles.swatch}
                    style={
                      color
                        ? {
                            background: `var(--column-${color}-bg)`,
                            borderColor: `var(--column-${color}-fg)`,
                          }
                        : undefined
                    }
                    aria-hidden="true"
                  />
                  {color ? t(`columnColors.${color}`) : t('settings.labels.noColor')}
                </label>
              ))}
            </div>
            <FieldErrors id={errorId('color')} issues={issuesAt('color')} />
          </fieldset>

          <div className={fields.field}>
            <label htmlFor={`${formId}-meaning`}>{t('settings.labels.meaning')}</label>
            <textarea
              id={`${formId}-meaning`}
              value={draft.meaning}
              maxLength={MEANING_MAX}
              aria-describedby={[`${formId}-meaning-help`, describedBy('meaning')].filter(Boolean).join(' ')}
              onChange={(event) => update({ meaning: event.target.value })}
            />
            <span className={styles.helpLine}>
              <span id={`${formId}-meaning-help`} className={fields.hintText}>
                {t('settings.labels.edit.meaningHelp')}
              </span>
              <span className={styles.counter}>
                {t('settings.labels.edit.meaningCount', { count: draft.meaning.length, max: MEANING_MAX })}
              </span>
            </span>
            <FieldErrors id={errorId('meaning')} issues={issuesAt('meaning')} />
          </div>

          <fieldset className={fields.group} aria-describedby={describedBy('who')}>
            <legend>{t('settings.labels.who')}</legend>
            {systemOwned ? (
              <p className={fields.hintText}>{t('settings.labels.edit.systemSetter')}</p>
            ) : (
              MODES.map((option) => (
                <Fragment key={option}>
                  <label className={clsx(fields.radio, mode === option && fields.picked)}>
                    <input
                      type="radio"
                      name={`${formId}-who`}
                      checked={mode === option}
                      disabled={option === 'humans' && !isOwner}
                      onChange={() => update({ mode: option })}
                    />
                    {t(`settings.labels.whoOptions.${option}`)}
                  </label>
                  {mode === option && option === 'duties' ? (
                    <SetterList
                      legend={t('settings.labels.edit.dutiesLegend')}
                      options={duties}
                      value={draft.duties}
                      disabled={frozen}
                      onChange={(value) => update({ duties: value as LabelDraft['duties'] })}
                    />
                  ) : null}
                  {mode === option && option === 'members' ? (
                    <SetterList
                      legend={t('settings.labels.members')}
                      options={memberOptions}
                      value={draft.members}
                      disabled={frozen}
                      onChange={(value) => update({ members: value })}
                    />
                  ) : null}
                </Fragment>
              ))
            )}
            {!systemOwned && (mode === 'duties' || mode === 'members') ? (
              <label className={fields.radio}>
                <input
                  type="checkbox"
                  checked={draft.humansOnly}
                  disabled={!isOwner}
                  onChange={(event) => update({ humansOnly: event.target.checked })}
                />
                {t('settings.labels.humansOnly')}
              </label>
            ) : null}
            {!systemOwned && !isOwner && (mode === 'humans' || mode === 'duties' || mode === 'members') ? (
              <p className={fields.lockText}>
                <Icon name="lock" size={13} /> {t('settings.edit.approvalOwnerOnly')}
              </p>
            ) : null}
            <FieldErrors id={errorId('who')} issues={issuesAt('who')} />
          </fieldset>

          <fieldset className={clsx(fields.group, styles.rulesGroup)}>
            <legend>{t('settings.labels.edit.rules')}</legend>
            <div className={fields.field}>
              <label htmlFor={`${formId}-group`}>{t('settings.labels.group')}</label>
              <input
                id={`${formId}-group`}
                value={draft.group}
                placeholder={t('settings.labels.groupHint')}
                aria-invalid={invalid('group')}
                aria-describedby={[`${formId}-group-help`, describedBy('group')].filter(Boolean).join(' ')}
                onChange={(event) => update({ group: event.target.value })}
              />
              <span id={`${formId}-group-help`} className={fields.hintText}>
                {t('settings.labels.edit.groupHelp')}
              </span>
              <FieldErrors id={errorId('group')} issues={issuesAt('group')} />
            </div>
            {(['notByAuthor', 'requiresComment', 'notifyAssignee', 'blocks'] as const).map((flag) => (
              <label key={flag} className={fields.radio}>
                <input
                  type="checkbox"
                  checked={draft[flag]}
                  onChange={(event) => update({ [flag]: event.target.checked })}
                />
                {t(`settings.labels.${flag}`)}
              </label>
            ))}
            {(['moved_back', 'pr_updated'] as const).map((trigger) => (
              <label key={trigger} className={fields.radio}>
                <input
                  type="checkbox"
                  checked={draft.clearedWhen.includes(trigger)}
                  onChange={(event) =>
                    update({
                      clearedWhen: event.target.checked
                        ? [...draft.clearedWhen, trigger]
                        : draft.clearedWhen.filter((entry) => entry !== trigger),
                    })
                  }
                />
                {t(`settings.labels.clearedWhen.${trigger}`)}
              </label>
            ))}
          </fieldset>
        </fieldset>
      </form>

      {creating ? (
        <p className={fields.id}>
          {t('settings.pipeline.id')} <code>{newId}</code>
          {tag ? null : <> {t('settings.labels.edit.idFromName')}</>}
        </p>
      ) : (
        <>
          <section className={fields.group} aria-labelledby={`${formId}-where`}>
            <h3 id={`${formId}-where`} className={fields.hintText}>
              {t('settings.labels.edit.where')}
            </h3>
            <UsageList uses={uses} />
          </section>
          <div className={styles.remove}>
            <Button
              variant="danger"
              disabled={disabled || removeBlock !== null}
              aria-describedby={removeBlock === null ? undefined : `${formId}-remove-reason`}
              onClick={() => setConfirming(true)}
            >
              {t('settings.labels.remove')}
            </Button>
            {removeBlock === null ? null : (
              <p id={`${formId}-remove-reason`} className={styles.removeReason}>
                <Icon name="lock" size={13} /> {removeBlock}
              </p>
            )}
          </div>
          <p className={fields.id}>
            {t('settings.pipeline.id')} <code>{labelKey}</code>
          </p>
        </>
      )}
      {saved ? (
        <Dialog
          open={confirming}
          role="alertdialog"
          size="sm"
          title={t('settings.labels.edit.removeTitle', { name: saved.name })}
          description={t('settings.labels.edit.removeBody')}
          onClose={() => {
            if (!edit.saving) setConfirming(false);
          }}
          footer={
            <>
              <Button autoFocus size="md" disabled={edit.saving} onClick={() => setConfirming(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="md"
                variant="dangerSolid"
                loading={edit.saving}
                onClick={() => {
                  void edit.remove().then((failure) => {
                    setConfirming(false);
                    if (failure) return;
                    edit.discard();
                    setRemoved(true);
                  });
                }}
              >
                {t('settings.labels.edit.removeConfirm')}
              </Button>
            </>
          }
        />
      ) : null}
    </DetailPanel>
  );
}

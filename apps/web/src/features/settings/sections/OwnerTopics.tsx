import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { DEFAULT_OWNER_DECISION_TOPICS } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { isApiError } from '../../../api/client';
import { Button } from '../../../components/Button';
import { TextField, TextAreaField } from '../../../components/Field';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { Icon } from '../../../components/Icon';
import { t, tDynamic } from '../../../i18n/t';
import { issueMessage } from '../../../lib/configIssues';
import type { IssueRef } from '../../../lib/configIssues';
import { errorMessage } from '../../../lib/errors';
import { builtInOwnerTopicIds, newOwnerTopicId, ownerTopicLabel } from '../../../lib/ownerTopics';
import { useInstantLimits } from '../SettingsEditor';
import shared from '../settings.module.css';

export function OwnerTopics({ config }: { config: ProjectConfig }) {
  const { isOwner, can } = useProject();
  const { shown, saving, locked, commit, error } = useInstantLimits(config);
  const topics = shown.team.ownerDecisionTopics ?? [...DEFAULT_OWNER_DECISION_TOPICS];
  const custom = topics.filter(({ id }) => !builtInOwnerTopicIds.includes(id));
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [hint, setHint] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [submittedIndex, setSubmittedIndex] = useState<number | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const hintInput = useRef<HTMLTextAreaElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const returnFocus = useRef(false);
  const location = useLocation();
  const field = new URLSearchParams(location.search).get('field');
  useEffect(() => {
    if (!field?.startsWith('ownerDecisionTopics')) return;
    setOpen(true);
    if (details.current) details.current.open = true;
    const control = [...(details.current?.querySelectorAll<HTMLElement>('[data-topic-field]') ?? [])].find(
      (element) => element.dataset.topicField === field,
    );
    (control ?? details.current?.querySelector('summary'))?.focus();
  }, [field, location.key]);
  useEffect(() => {
    if (adding) labelInput.current?.focus();
  }, [adding]);
  useEffect(() => {
    if (!saving && returnFocus.current) {
      returnFocus.current = false;
      addButton.current?.focus();
    }
  }, [saving, adding]);
  const issues = isApiError(error)
    ? ((error.details as { issues?: IssueRef[] } | undefined)?.issues ?? [])
    : [];
  const fieldIssue = (name: string) =>
    issues.find(
      ({ path }) =>
        path.replace(/\[(\d+)\]/g, '.$1').replace(/^team\./, '') ===
        `ownerDecisionTopics.${submittedIndex}.${name}`,
    );
  const labelError =
    invalid && !label.trim()
      ? t('settings.team.ownerTopics.labelRequired')
      : fieldIssue('label')
        ? issueMessage(fieldIssue('label')!)
        : null;
  const hintError =
    invalid && !hint.trim()
      ? t('settings.team.ownerTopics.hintRequired')
      : fieldIssue('hint')
        ? issueMessage(fieldIssue('hint')!)
        : null;
  const names = topics.map(({ id }) => ownerTopicLabel(id, shown)).join(', ');
  const finish = () => {
    returnFocus.current = true;
    setAdding(false);
    setLabel('');
    setHint('');
    setInvalid(false);
    setSubmittedIndex(null);
    addButton.current?.focus();
  };
  const update = (next: typeof topics) =>
    commit((draft) => {
      draft.team.ownerDecisionTopics = [
        ...builtInOwnerTopicIds.flatMap((id) => next.filter((topic) => topic.id === id)),
        ...next.filter(({ id }) => !builtInOwnerTopicIds.includes(id)),
      ];
    });
  return (
    <section className={shared.ownerTopics} aria-labelledby="settings-owner-topics-title">
      <h3 id="settings-owner-topics-title" className={shared.groupTitle}>
        {t('settings.team.ownerTopics.title')}
      </h3>
      {!isOwner ? (
        <>
          <dl className={shared.facts}>
            <div>
              <dt>{t('settings.team.ownerTopics.readOnly')}</dt>
              <dd>{names || t('settings.team.ownerTopics.none')}</dd>
            </div>
          </dl>
          {can.manageTeam ? <p className={shared.help}>{t('settings.team.ownerTopics.ownerOnly')}</p> : null}
        </>
      ) : (
        <fieldset className={shared.controls} disabled={locked || saving} aria-busy={saving}>
          <p className={shared.help}>{t('settings.team.ownerTopics.help')}</p>
          <div className={shared.summaryBlock} aria-live="polite">
            {names
              ? t('settings.team.ownerTopics.enabled', { topics: names })
              : t('settings.team.ownerTopics.empty')}
          </div>
          {!topics.length ? (
            <p className={shared.warning} role="status">
              {t('settings.team.ownerTopics.warning')}
            </p>
          ) : null}
          <details ref={details} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary className={shared.foldSummary}>
              <Icon name="chevronRight" size={14} className={shared.chevron} />
              {t('settings.team.ownerTopics.edit')}
            </summary>
            <fieldset className={shared.controls}>
              <legend className={shared.fieldLabel}>{t('settings.team.ownerTopics.builtIn')}</legend>
              {builtInOwnerTopicIds.map((id) => {
                const topic = topics.find((entry) => entry.id === id);
                return (
                  <label key={id} className={shared.contactRow}>
                    <input
                      type="checkbox"
                      checked={!!topic}
                      disabled={!topic && topics.length >= 12}
                      aria-describedby={`owner-topic-${id}-hint`}
                      aria-labelledby={`owner-topic-${id}-label`}
                      data-topic-field={`ownerDecisionTopics.${topics.findIndex((entry) => entry.id === id)}.id`}
                      onChange={(event) => {
                        void update(
                          event.target.checked
                            ? [...topics, { id }]
                            : topics.filter((entry) => entry.id !== id),
                        );
                      }}
                    />
                    <span className={shared.dutyText}>
                      <strong
                        id={`owner-topic-${id}-label`}
                        tabIndex={-1}
                        data-topic-field={`ownerDecisionTopics.${topics.indexOf(topic!)}.label`}
                      >
                        {ownerTopicLabel(id, shown)}
                      </strong>
                      <span
                        id={`owner-topic-${id}-hint`}
                        tabIndex={-1}
                        data-topic-field={`ownerDecisionTopics.${topics.indexOf(topic!)}.hint`}
                        className={shared.dutyHolders}
                      >
                        {topic?.hint ?? tDynamic(`ownerTopics.builtIn.${id}.hint`, id)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <h4 className={`${shared.fieldLabel} ${shared.ownerTopicsCustomTitle}`}>
              {t('settings.team.ownerTopics.custom')}
            </h4>
            {custom.length ? (
              custom.map((topic) => (
                <div key={topic.id} className={`${shared.contactRow} ${shared.ownerTopicRow}`}>
                  <span className={shared.dutyText}>
                    <strong
                      tabIndex={-1}
                      data-topic-field={`ownerDecisionTopics.${topics.indexOf(topic)}.label`}
                    >
                      {topic.label}
                    </strong>
                    <span
                      tabIndex={-1}
                      data-topic-field={`ownerDecisionTopics.${topics.indexOf(topic)}.hint`}
                      className={shared.dutyHolders}
                    >
                      {topic.hint}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    aria-label={t('settings.team.ownerTopics.removeLabel', {
                      label: topic.label ?? topic.id,
                    })}
                    onClick={async () => {
                      returnFocus.current = true;
                      await update(topics.filter((entry) => entry.id !== topic.id));
                    }}
                  >
                    {t('settings.team.ownerTopics.remove')}
                  </Button>
                </div>
              ))
            ) : (
              <p className={shared.help}>{t('settings.team.ownerTopics.noCustom')}</p>
            )}
            <div hidden={adding}>
              <Button
                ref={addButton}
                variant="secondary"
                icon="plus"
                disabled={topics.length >= 12}
                onClick={() => {
                  setAdding(true);
                  setInvalid(false);
                }}
              >
                {t('settings.team.ownerTopics.add')}
              </Button>
            </div>
            {adding ? (
              <form
                className={shared.ownerTopicForm}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    finish();
                  }
                }}
                onSubmit={async (event) => {
                  event.preventDefault();
                  setInvalid(true);
                  if (!label.trim() || !hint.trim()) {
                    (!label.trim() ? labelInput.current : hintInput.current)?.focus();
                    return;
                  }
                  setSubmittedIndex(topics.length);
                  if (
                    await update([
                      ...topics,
                      {
                        id: newOwnerTopicId(
                          label,
                          topics.map(({ id }) => id),
                        ),
                        label: label.trim(),
                        hint: hint.trim(),
                      },
                    ])
                  )
                    finish();
                }}
              >
                <TextField
                  ref={labelInput}
                  label={t('settings.team.ownerTopics.label')}
                  placeholder={t('settings.team.ownerTopics.labelPlaceholder')}
                  maxLength={60}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  error={labelError}
                />
                <TextAreaField
                  ref={hintInput}
                  label={t('settings.team.ownerTopics.hint')}
                  placeholder={t('settings.team.ownerTopics.hintPlaceholder')}
                  hint={t('settings.team.ownerTopics.hintHelp')}
                  maxLength={300}
                  value={hint}
                  onChange={(event) => setHint(event.target.value)}
                  error={hintError}
                />
                <div className={shared.actions}>
                  <Button type="submit" variant="primary">
                    {t('settings.team.ownerTopics.submit')}
                  </Button>
                  <Button variant="secondary" onClick={finish}>
                    {t('settings.team.ownerTopics.cancel')}
                  </Button>
                </div>
              </form>
            ) : null}
            {topics.length >= 12 ? (
              <p className={shared.help}>{t('settings.team.ownerTopics.limit')}</p>
            ) : null}
            {error && !labelError && !hintError ? (
              <ErrorBanner>
                {issues.length ? issues.map(issueMessage).join(' ') : errorMessage(error)}
              </ErrorBanner>
            ) : null}
          </details>
        </fieldset>
      )}
    </section>
  );
}

import clsx from 'clsx';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import {
  cardMerger,
  cardMoverHandle,
  cardMoverOf,
  complexitySetterMembers,
  complexitySettersOf,
  contactHandles,
  DUTIES,
  DUTY_GROUPS,
  DUTY_IDS,
  dutyMembers,
  hasAccess,
  isDeveloper,
  mergerOf,
  prerequisiteOverrideOf,
  PrioritySetter,
  prioritySetterCandidates,
  prioritySetterMembers,
  prioritySettersOf,
  ProjectManagerLifecycleAction,
  projectManagerLifecycleOf,
  projectManagerMovesOf,
  projectManagerOf,
  projectManagersOf,
  TaskCreateAccess,
  taskCreateAccessOf,
  viewerRecipientsOf,
  writableRecipientHandles,
} from '@projectman/shared';
import type { MemberConfig, ProjectConfig, RoleView } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { isApiError } from '../../../api/client';
import { useRoles } from '../../../api/queries';
import { useProject, useProjectIndexes } from '../../../app/contexts';
import { Avatar } from '../../../components/Avatar';
import { Chip } from '../../../components/Chip';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { Icon } from '../../../components/Icon';
import { MoverChoice } from '../../../components/MoverChoice';
import { SelectField } from '../../../components/Field';
import { t } from '../../../i18n/t';
import { issueMessage } from '../../../lib/configIssues';
import type { IssueRef } from '../../../lib/configIssues';
import { errorMessage } from '../../../lib/errors';
import { roleLabel } from '../../../lib/members';
import { useInstantLimits } from '../SettingsEditor';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';
import { OwnerTopics } from './OwnerTopics';

function memberRole(member: MemberConfig, roles: readonly RoleView[]): string {
  return member.kind === 'human'
    ? roleLabel(
        {
          handle: member.handle,
          displayName: member.displayName,
          kind: 'human',
          role: member.access,
        },
        roles,
      )
    : roleLabel(
        {
          handle: member.handle,
          displayName: member.displayName,
          kind: 'ai',
          role: member.role,
          specialty: member.specialty,
        },
        roles,
      );
}

/** Who the code reviewer kind resolves to without a card: the first owner of the code review stage. */
function reviewerName(config: ProjectConfig): string | null {
  const handle = cardMerger(
    { ...config, team: { ...config.team, merger: { kind: 'code_reviewer' } } },
    { assignee: null },
    null,
  );
  return config.team.members.find((member) => member.handle === handle)?.displayName ?? null;
}

/** The members who may merge: AI members and humans with developer access or more. */
function mergerCandidates(config: ProjectConfig): MemberConfig[] {
  return config.team.members.filter(
    (member) => member.kind === 'ai' || hasAccess(member.access, 'developer'),
  );
}

/** The merger as a sentence, for those who may not change it. */
function mergerValue(config: ProjectConfig): string {
  const merger = mergerOf(config);
  if (merger.kind === 'developer') return t('settings.team.merger.value.developer');
  if (merger.kind === 'member') {
    const name = config.team.members.find((member) => member.handle === merger.handle)?.displayName;
    return t('settings.team.merger.value.member', { name: name ?? merger.handle });
  }
  const name = reviewerName(config);
  return name
    ? t('settings.team.merger.codeReviewer', { name })
    : t('settings.team.merger.value.codeReviewer');
}

/** The merger the project has: a select of who merges, and a member picker for a named one. Saves as it changes. */
function MergerControls({ config }: { config: ProjectConfig }) {
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  const merger = mergerOf(shown);
  const candidates = mergerCandidates(shown);
  const name = reviewerName(shown);
  const issues = isApiError(error)
    ? (error.details as { issues?: IssueRef[] } | undefined)?.issues
    : undefined;
  const unresolved = issues?.find((issue) => issue.code === 'merger_unresolved');
  return (
    <fieldset className={shared.controls} disabled={locked} aria-busy={saving}>
      <SelectField
        label={t('settings.team.merger.kindLabel')}
        hint={t('settings.team.merger.help')}
        value={merger.kind}
        error={unresolved ? issueMessage(unresolved) : null}
        onChange={(event) => {
          const kind = event.target.value;
          commit((draft) => {
            if (kind === 'member') {
              const first = mergerCandidates(draft)[0];
              if (first) draft.team.merger = { kind: 'member', handle: first.handle };
            } else if (kind === 'developer' || kind === 'code_reviewer') draft.team.merger = { kind };
          });
        }}
      >
        <option value="code_reviewer">
          {name
            ? t('settings.team.merger.codeReviewer', { name })
            : t('settings.team.merger.codeReviewerUnknown')}
        </option>
        <option value="developer">{t('settings.team.merger.developer')}</option>
        <option value="member" disabled={candidates.length === 0}>
          {t('settings.team.merger.member')}
        </option>
      </SelectField>
      {merger.kind === 'member' ? (
        <SelectField
          label={t('settings.team.merger.memberLabel')}
          value={merger.handle}
          onChange={(event) =>
            commit((draft) => {
              draft.team.merger = { kind: 'member', handle: event.target.value };
            })
          }
        >
          {candidates.some((member) => member.handle === merger.handle) ? null : (
            <option value={merger.handle}>{merger.handle}</option>
          )}
          {candidates.map((member) => (
            <option key={member.handle} value={member.handle}>
              {member.displayName}
            </option>
          ))}
        </SelectField>
      ) : null}
      {error && !unresolved ? (
        <p role="alert" className={shared.validation}>
          {errorMessage(error)}
        </p>
      ) : null}
    </fieldset>
  );
}

/** The humans who may carry the cards on: developer access or more (the same rule as the invariant's). */
function moverCandidates(config: ProjectConfig): MemberConfig[] {
  return config.team.members.filter(
    (member) => member.kind === 'human' && hasAccess(member.access, 'developer'),
  );
}

function ProjectManagerMovesControls({ config }: { config: ProjectConfig }) {
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  return (
    <fieldset className={shared.controls} disabled={locked} aria-busy={saving}>
      <SelectField
        label={t('settings.team.projectManagerMoves.label')}
        hint={t('settings.team.projectManagerMoves.help')}
        value={projectManagerMovesOf(shown)}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'queues_and_start' || value === 'start_only')
            commit((draft) => {
              draft.team.projectManagerMoves = value;
            });
        }}
      >
        <option value="queues_and_start">{t('settings.team.projectManagerMoves.queues_and_start')}</option>
        <option value="start_only">{t('settings.team.projectManagerMoves.start_only')}</option>
      </SelectField>
      {error ? <ErrorBanner>{errorMessage(error)}</ErrorBanner> : null}
    </fieldset>
  );
}

/** The lifecycle actions the project manager may take on its own as lines, for those who may not change them. */
function lifecycleValue(config: ProjectConfig): string[] {
  const chosen = projectManagerLifecycleOf(config);
  return ProjectManagerLifecycleAction.options
    .filter((action) => chosen.includes(action))
    .map((action) => t(`settings.team.projectManagerLifecycle.${action}`));
}

/** What the project manager may do to a card's life on its own (PM-1098): a tick per action. Saves as it changes. */
function ProjectManagerLifecycleControls({ config, helpId }: { config: ProjectConfig; helpId: string }) {
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  const chosen = projectManagerLifecycleOf(shown);
  return (
    <fieldset
      className={shared.controls}
      disabled={locked || saving}
      aria-busy={saving}
      aria-describedby={helpId}
    >
      <legend className={shared.setterLegend}>{t('settings.team.projectManagerLifecycle.question')}</legend>
      {ProjectManagerLifecycleAction.options.map((action) => (
        <label key={action} className={shared.contactRow}>
          <input
            type="checkbox"
            checked={chosen.includes(action)}
            onChange={(event) =>
              commit((draft) => {
                const on = projectManagerLifecycleOf(draft);
                draft.team.projectManagerLifecycle = ProjectManagerLifecycleAction.options.filter((id) =>
                  id === action ? event.target.checked : on.includes(id),
                );
              })
            }
          />
          <span className={shared.dutyText}>
            <span>{t(`settings.team.projectManagerLifecycle.${action}`)}</span>
            <span className={shared.dutyHolders}>
              {t(`settings.team.projectManagerLifecycle.${action}Note`)}
            </span>
          </span>
        </label>
      ))}
      {projectManagerOf(shown) === null ? (
        <p className={shared.muted}>{t('settings.team.projectManagerLifecycle.noProjectManager')}</p>
      ) : chosen.length === 0 ? (
        <p className={shared.muted}>{t('settings.team.projectManagerLifecycle.adminsOnly')}</p>
      ) : null}
      {error ? <ErrorBanner>{errorMessage(error)}</ErrorBanner> : null}
    </fieldset>
  );
}

/**
 * Whether the project manager may start a card despite an open prerequisite (PM-1099): one tick, with the
 * member it reaches now. Saves as it changes.
 */
function PrerequisiteOverrideControls({ config, helpId }: { config: ProjectConfig; helpId: string }) {
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  const noteId = useId();
  const allowed = prerequisiteOverrideOf(shown) === 'people_and_project_manager';
  const names = projectManagersOf(shown).map((member) => member.displayName);
  return (
    <fieldset
      className={shared.controls}
      disabled={locked || saving}
      aria-busy={saving}
      aria-describedby={helpId}
    >
      <legend className={shared.setterLegend}>{t('settings.team.prerequisiteOverride.question')}</legend>
      <div>
        <label className={shared.contactRow}>
          <input
            type="checkbox"
            checked={allowed}
            aria-describedby={noteId}
            onChange={(event) =>
              commit((draft) => {
                draft.team.prerequisiteOverride = event.target.checked
                  ? 'people_and_project_manager'
                  : 'people';
              })
            }
          />
          <span>{t('settings.team.prerequisiteOverride.project_manager')}</span>
        </label>
        <p id={noteId} className={`${shared.muted} ${shared.setterNote}`}>
          {names.length
            ? t('settings.team.prerequisiteOverride.covers', { names: names.join(', ') })
            : t('settings.team.prerequisiteOverride.noProjectManager')}
        </p>
      </div>
      {allowed ? null : <p className={shared.muted}>{t('settings.team.prerequisiteOverride.humansOnly')}</p>}
      {error ? <ErrorBanner>{errorMessage(error)}</ErrorBanner> : null}
    </fieldset>
  );
}

/** The names of the AI members a priority source covers now, in team order. */
function setterNames(config: ProjectConfig, setter: PrioritySetter): string[] {
  return prioritySetterCandidates(config, setter).map((member) => member.displayName);
}

/** Who may set priorities as a sentence, for those who may not change it. */
function prioritySettersValue(config: ProjectConfig): string {
  const names = prioritySetterMembers(config).map((member) => member.displayName);
  return names.length
    ? t('settings.team.priority.value.with', { names: names.join(', ') })
    : t('settings.team.priority.value.humansOnly');
}

/** Who besides people may set a card's priority (PM-1096): a tick per source, with whom it covers now. Saves as it changes. */
function PriorityControls({ config, helpId }: { config: ProjectConfig; helpId: string }) {
  const { key } = useProject();
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  const noteId = useId();
  const chosen = prioritySettersOf(shown);
  return (
    <fieldset
      className={shared.controls}
      disabled={locked || saving}
      aria-busy={saving}
      aria-describedby={helpId}
    >
      <legend className={shared.setterLegend}>{t('settings.team.priority.question')}</legend>
      {PrioritySetter.options.map((setter) => {
        const names = setterNames(shown, setter);
        const rowId = `${noteId}-${setter}`;
        return (
          <div key={setter}>
            <label className={shared.contactRow}>
              <input
                type="checkbox"
                checked={chosen.includes(setter)}
                aria-describedby={rowId}
                onChange={(event) =>
                  commit((draft) => {
                    const on = prioritySettersOf(draft);
                    draft.team.prioritySetters = PrioritySetter.options.filter((id) =>
                      id === setter ? event.target.checked : on.includes(id),
                    );
                  })
                }
              />
              <span>
                {setter === 'project_manager'
                  ? t('settings.team.priority.project_manager')
                  : t('settings.team.priority.duty', { duty: t('dutyNames.prioritization') })}
              </span>
            </label>
            <p id={rowId} className={`${shared.muted} ${shared.setterNote}`}>
              {names.length
                ? t('settings.team.priority.covers', { names: names.join(', ') })
                : setter === 'project_manager'
                  ? t('settings.team.priority.noProjectManager')
                  : t('settings.team.priority.noDutyHolder')}
              {names.length === 0 && setter === 'prioritization_duty' ? (
                <>
                  {' '}
                  <Link to={`/p/${key}/settings/duties`}>{t('duties.title')}</Link>
                </>
              ) : null}
            </p>
          </div>
        );
      })}
      {chosen.length === 0 ? <p className={shared.muted}>{t('settings.team.priority.humansOnly')}</p> : null}
      {error ? <ErrorBanner>{errorMessage(error)}</ErrorBanner> : null}
    </fieldset>
  );
}

/** Whether the AI members' explicit assignments also have to fit the complexity limit (PM-1137). Saves as it changes. */
function AssigneeFitControls({ config, helpId }: { config: ProjectConfig; helpId: string }) {
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  const noteId = useId();
  return (
    <fieldset
      className={shared.controls}
      disabled={locked || saving}
      aria-busy={saving}
      aria-describedby={helpId}
    >
      <label className={`${shared.contactRow} ${shared.choiceRow}`}>
        <input
          type="checkbox"
          checked={shown.team.assigneeFit === 'automatic_and_ai'}
          aria-describedby={noteId}
          onChange={(event) =>
            commit((draft) => {
              draft.team.assigneeFit = event.target.checked ? 'automatic_and_ai' : 'automatic';
            })
          }
        />
        <span className={shared.dutyText}>
          <span>{t('settings.team.assigneeFit.question')}</span>
          <span id={noteId} className={shared.dutyHolders}>
            {t('settings.team.assigneeFit.note')}
          </span>
        </span>
      </label>
      {error ? <ErrorBanner>{errorMessage(error)}</ErrorBanner> : null}
    </fieldset>
  );
}

/** The first stage's name: where a client's new card starts (PM-1100). */
function firstStageName(config: ProjectConfig): string {
  return config.pipeline.stages[0]?.name ?? '';
}

/** Who may open a new card: four radios, each listing the roles it lets in, saved at once (PM-1100). */
function TaskCreateControls({ config }: { config: ProjectConfig }) {
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  const chosen = taskCreateAccessOf(shown);
  const noteId = useId();
  return (
    <fieldset className={shared.controls} disabled={locked || saving} aria-busy={saving}>
      <legend className={shared.setterLegend}>{t('settings.team.taskCreate.question')}</legend>
      <div className={shared.choiceList}>
        {TaskCreateAccess.options.map((access) => (
          <label key={access} className={`${shared.contactRow} ${shared.choiceRow}`}>
            <input
              type="radio"
              name="task-create-access"
              value={access}
              checked={chosen === access}
              aria-describedby={access === 'client' ? noteId : undefined}
              onChange={() =>
                commit((draft) => {
                  draft.team.taskCreateAccess = access;
                })
              }
            />
            <span className={shared.dutyText}>
              <span>{t(`settings.team.taskCreate.options.${access}`)}</span>
              {access === 'client' ? (
                <span id={noteId} className={shared.dutyHolders}>
                  {t('settings.team.taskCreate.clientNote', { stage: firstStageName(shown) })}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      {error ? <ErrorBanner>{errorMessage(error)}</ErrorBanner> : null}
    </fieldset>
  );
}

/** The card mover as a sentence, for those who may not change it. */
function moverValue(config: ProjectConfig): string {
  const mover = cardMoverOf(config);
  if (mover.kind === 'worker') return t('settings.team.mover.value.worker');
  const handle = cardMoverHandle(config) ?? (mover.kind === 'human' ? mover.handle : null);
  const name = config.team.members.find((member) => member.handle === handle)?.displayName ?? handle ?? '';
  return t(`settings.team.mover.value.${mover.kind}`, { name });
}

/** Who carries the cards on: the three choices, and a picker for "one person". Saves as it changes. */
function MoverControls({ config }: { config: ProjectConfig }) {
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  const mover = cardMoverOf(shown);
  const candidates = moverCandidates(shown);
  const issues = isApiError(error)
    ? (error.details as { issues?: IssueRef[] } | undefined)?.issues
    : undefined;
  const refused = issues?.find((issue) => issue.code.startsWith('mover_'));
  // Who the refused choice named: the page shows the saved choice again, so the name is kept here.
  const [tried, setTried] = useState('');
  const refusal = refused
    ? refused.code === 'mover_on_leave'
      ? issueMessage(refused)
      : t('settings.team.mover.cannotMove', { name: tried })
    : null;
  const current = mover.kind === 'human' ? mover.handle : null;
  const currentMember = shown.team.members.find((member) => member.handle === current);
  // A choice that cannot move cards says so under the field, saved or not.
  const wrong =
    mover.kind === 'human' && !candidates.some((member) => member.handle === current)
      ? t('settings.team.mover.cannotMove', { name: currentMember?.displayName ?? current ?? '' })
      : null;
  return (
    <fieldset className={shared.controls} disabled={locked} aria-busy={saving}>
      <MoverChoice
        name="card-mover"
        value={mover.kind}
        legend={t('settings.team.mover.label')}
        onChange={(kind) => {
          if (kind === 'human' && candidates.length === 0) return;
          commit((draft) => {
            if (kind === 'human') {
              const first = moverCandidates(draft)[0];
              if (first) {
                draft.team.cardMover = { kind: 'human', handle: first.handle };
                setTried(first.displayName);
              }
            } else {
              draft.team.cardMover = { kind };
              // The name the choice carries on its card, which starts the sentence ("A Projektmenedzser nem …").
              setTried(kind === 'project_manager' ? t('settings.team.mover.project_manager.title') : '');
            }
          });
        }}
        humanExtra={
          <SelectField
            label={t('settings.team.mover.who')}
            value={current ?? ''}
            error={wrong}
            onChange={(event) => {
              const handle = event.target.value;
              setTried(candidates.find((member) => member.handle === handle)?.displayName ?? handle);
              commit((draft) => {
                draft.team.cardMover = { kind: 'human', handle };
              });
            }}
          >
            {current && !candidates.some((member) => member.handle === current) ? (
              <option value={current}>{currentMember?.displayName ?? current}</option>
            ) : null}
            {candidates.map((member) => (
              <option key={member.handle} value={member.handle}>
                {member.displayName}
              </option>
            ))}
          </SelectField>
        }
      />
      {refusal ? (
        <p role="alert" className={shared.fieldError}>
          {refusal}
        </p>
      ) : error ? (
        <p role="alert" className={shared.validation}>
          {errorMessage(error)}
        </p>
      ) : null}
    </fieldset>
  );
}

/** The chosen duties' names in the fixed duty order, so a tick never reorders the sentence. */
function complexityDutyNames(config: ProjectConfig): string[] {
  const chosen = complexitySettersOf(config);
  const { duties } = getLocale(config.project.language);
  return DUTY_IDS.filter((id) => chosen.includes(id)).map((id) => duties[id].name);
}

/** Who may set complexity as a sentence, for those who may not change it. */
function complexityValue(config: ProjectConfig): string {
  const duties = complexityDutyNames(config);
  return duties.length
    ? t('settings.team.complexity.value.with', { duties: duties.join(', ') })
    : t('settings.team.complexity.value.ownerOnly');
}

/**
 * Which duties' holders may set a card's complexity points (PM-1097): a summary of who may now, and the
 * duty list in a folded part, a tick per duty saved at once. The project owners may always.
 */
function ComplexityControls({ config }: { config: ProjectConfig }) {
  const { key } = useProject();
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  const [open, setOpen] = useState(false);
  const helpId = useId();
  const chosen = complexitySettersOf(shown);
  const { duties } = getLocale(shown.project.language);
  const names = (list: readonly { displayName: string }[]) => list.map((m) => m.displayName).join(', ');
  const dutyList = DUTY_IDS.filter((id) => chosen.includes(id)).map((id) => duties[id].name);
  const setters = complexitySetterMembers(shown);
  const unheld = DUTY_IDS.filter((id) => chosen.includes(id) && dutyMembers(shown, id).length === 0);
  const developers = setters.filter((member) => isDeveloper(shown, member));
  return (
    <fieldset
      className={shared.controls}
      disabled={locked || saving}
      aria-busy={saving}
      aria-labelledby="settings-complexity-title"
      aria-describedby={helpId}
    >
      <p id={helpId} className={shared.help}>
        {t('settings.team.complexity.help')}
      </p>
      <div className={shared.summaryBlock}>
        <p>
          {dutyList.length
            ? t('settings.team.complexity.duties', { duties: dutyList.join(', ') })
            : t('settings.team.complexity.ownerOnly')}
        </p>
        <p className={shared.muted} aria-live="polite">
          {t('settings.team.complexity.covers', { names: names(setters) })}
        </p>
        {unheld.length ? (
          <p className={shared.muted}>
            {t('settings.team.complexity.unheld', { duties: unheld.map((id) => duties[id].name).join(', ') })}{' '}
            <Link to={`/p/${key}/settings/duties`}>{t('duties.title')}</Link>
          </p>
        ) : null}
        {developers.length ? (
          <p className={shared.warning}>
            {t('settings.team.complexity.developerWarning', { names: names(developers) })}
          </p>
        ) : null}
      </div>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className={shared.foldSummary}>
          <Icon name="chevronRight" size={14} strokeWidth={2.4} className={shared.chevron} />
          {t('settings.team.complexity.choose')}
        </summary>
        <fieldset className={shared.controls} disabled={locked || saving} aria-busy={saving}>
          <legend className={shared.legendGap}>{t('settings.team.complexity.question')}</legend>
          {DUTY_GROUPS.map((group) => (
            <div
              key={group}
              role="group"
              className={shared.subGroup}
              aria-labelledby={`settings-complexity-group-${group}`}
            >
              <p id={`settings-complexity-group-${group}`} className={shared.fieldLabel}>
                {t(`duties.${group}`)}
              </p>
              {DUTY_IDS.filter((id) => DUTIES[id].group === group).map((id) => {
                const holders = dutyMembers(shown, id);
                return (
                  <div key={id}>
                    <label className={shared.contactRow}>
                      <input
                        type="checkbox"
                        checked={chosen.includes(id)}
                        aria-labelledby={`settings-complexity-name-${id}`}
                        aria-describedby={`settings-complexity-holders-${id}`}
                        onChange={(event) =>
                          commit((draft) => {
                            const next = new Set(complexitySettersOf(draft));
                            if (event.target.checked) next.add(id);
                            else next.delete(id);
                            draft.team.complexitySetters = DUTY_IDS.filter((duty) => next.has(duty));
                          })
                        }
                      />
                      <span className={shared.dutyText}>
                        <span id={`settings-complexity-name-${id}`}>{duties[id].name}</span>
                        <span id={`settings-complexity-holders-${id}`} className={shared.dutyHolders}>
                          {holders.length
                            ? t('settings.team.complexity.holders', { names: names(holders) })
                            : t('settings.team.complexity.noHolder')}
                        </span>
                      </span>
                    </label>
                  </div>
                );
              })}
            </div>
          ))}
          {error ? <ErrorBanner>{errorMessage(error)}</ErrorBanner> : null}
        </fieldset>
      </details>
    </fieldset>
  );
}

/** The contacts as a sentence: their names, or that there are none. */
function contactsValue(config: ProjectConfig): string {
  const names = contactHandles(config).map(
    (handle) => config.team.members.find((member) => member.handle === handle)?.displayName ?? handle,
  );
  return names.length ? names.join(', ') : t('settings.team.contacts.none');
}

/** The contacts hint, and in the contacts mode that the viewer is held to them too (PM-1102). */
function ContactsHint({ config }: { config: ProjectConfig }) {
  return (
    <>
      {t('settings.team.contacts.hint')}
      {viewerRecipientsOf(config) === 'contacts' ? ` ${t('settings.team.contacts.viewerToo')}` : ''}
    </>
  );
}

/** What the viewer's setting leaves them: nobody (a warning), or the manager left out (plain); else nothing. */
function ViewerRecipientsStatus({ config }: { config: ProjectConfig }) {
  const handles = writableRecipientHandles(config, 'viewer') ?? [];
  const mode = viewerRecipientsOf(config);
  const manager = projectManagerOf(config);
  if (handles.length === 0)
    return (
      <p role="status" className={clsx(shared.help, shared.warning)}>
        {t(
          mode === 'contacts'
            ? 'settings.team.viewerRecipients.noContacts'
            : 'settings.team.viewerRecipients.noManager',
        )}
      </p>
    );
  if (mode === 'contacts' && manager && !handles.includes(manager.handle))
    return (
      <p role="status" className={shared.help}>
        {t('settings.team.viewerRecipients.managerNotContact')}
      </p>
    );
  return null;
}

/** Whom the read-only viewer may write to (PM-1102): the project manager or the contacts. Saves as it changes. */
function ViewerRecipientsControls({ config }: { config: ProjectConfig }) {
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  return (
    <fieldset className={clsx(shared.controls, shared.controlsBelow)} disabled={locked} aria-busy={saving}>
      <SelectField
        label={t('settings.team.viewerRecipients.label')}
        hint={t('settings.team.viewerRecipients.help')}
        value={viewerRecipientsOf(shown)}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'project_manager' || value === 'contacts')
            commit((draft) => {
              draft.team.viewerRecipients = value;
            });
        }}
      >
        <option value="project_manager">{t('settings.team.viewerRecipients.project_manager')}</option>
        <option value="contacts">{t('settings.team.viewerRecipients.contacts')}</option>
      </SelectField>
      <ViewerRecipientsStatus config={shown} />
      {error ? <ErrorBanner>{errorMessage(error)}</ErrorBanner> : null}
    </fieldset>
  );
}

/** Who may be written to by the members who write only to the contacts (PM-985): a tick per member, saved at once. */
function ContactControls({ config }: { config: ProjectConfig }) {
  const { key } = useProject();
  const { members } = useProjectIndexes(key);
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  const hintId = useId();
  const chosen = new Set(contactHandles(shown));
  return (
    <fieldset
      className={shared.controls}
      disabled={locked || saving}
      aria-busy={saving}
      aria-labelledby="settings-contacts-title"
      aria-describedby={hintId}
    >
      <p id={hintId} className={shared.help}>
        <ContactsHint config={shown} />
      </p>
      {shown.team.members.map((member) => (
        <label key={member.handle} className={shared.contactRow}>
          <input
            type="checkbox"
            checked={chosen.has(member.handle)}
            onChange={(event) =>
              commit((draft) => {
                const rest = (draft.team.contacts ?? []).filter((handle) => handle !== member.handle);
                draft.team.contacts = event.target.checked ? [...rest, member.handle] : rest;
              })
            }
          />
          <Avatar member={members.get(member.handle)} handle={member.handle} size="sm" />
          <span>
            {member.displayName} <code className={shared.id}>{member.handle}</code>
          </span>
        </label>
      ))}
      {error ? <ErrorBanner>{errorMessage(error)}</ErrorBanner> : null}
    </fieldset>
  );
}

/**
 * The configured members in short: name and role. Model, permissions, capacity and subscription
 * are the Team page's business, which this links to instead of repeating them. Below them, who
 * merges the approved work into the main branch (PM-453).
 */
export function TeamSection({ config }: { config: ProjectConfig }) {
  const { key, can, isOwner } = useProject();
  const roles = useRoles(key);
  const priorityHelpId = useId();
  const assigneeFitHelpId = useId();
  const lifecycleHelpId = useId();
  const prerequisiteHelpId = useId();
  return (
    <SettingsSection id="settings-team" title={t('settings.sections.team')}>
      <ul className={shared.members}>
        {config.team.members.map((member) => (
          <li key={member.handle}>
            <span className={shared.strong}>
              {member.displayName}
              {member.kind === 'ai' ? (
                <>
                  {' '}
                  <Chip tone="dark">{t('common.ai')}</Chip>
                </>
              ) : null}
            </span>
            <span className={shared.muted}>
              {memberRole(member, roles.data?.roles ?? [])} ·{' '}
              <code className={shared.id}>{member.handle}</code>
            </span>
          </li>
        ))}
      </ul>
      <p className={shared.muted}>
        <Link to={`/p/${key}/team`}>{t('settings.team.manage')}</Link>
      </p>
      <section aria-labelledby="settings-task-create-title">
        <h3 id="settings-task-create-title" className={shared.groupTitle}>
          {t('settings.team.taskCreate.title')}
        </h3>
        <div className={shared.controls}>
          <p className={shared.help}>{t('settings.team.taskCreate.help')}</p>
          {isOwner ? (
            <TaskCreateControls config={config} />
          ) : (
            <>
              <dl className={shared.facts}>
                <div>
                  <dt>{t('settings.team.taskCreate.question')}</dt>
                  <dd>{t(`settings.team.taskCreate.options.${taskCreateAccessOf(config)}`)}</dd>
                </div>
              </dl>
              {taskCreateAccessOf(config) === 'client' ? (
                <p className={shared.help}>
                  {t('settings.team.taskCreate.clientNote', { stage: firstStageName(config) })}
                </p>
              ) : null}
              {can.manageTeam ? (
                <p className={shared.help}>{t('settings.team.taskCreate.ownerOnly')}</p>
              ) : null}
            </>
          )}
        </div>
      </section>
      <OwnerTopics config={config} />
      <section aria-labelledby="settings-mover-title">
        <h3 id="settings-mover-title" className={shared.groupTitle}>
          {t('settings.team.mover.label')}
        </h3>
        <div className={shared.controls}>
          <p className={shared.help}>{t('settings.team.mover.help')}</p>
          {can.manageTeam ? (
            <MoverControls config={config} />
          ) : (
            <dl className={shared.facts}>
              <div>
                <dt>{t('settings.team.mover.label')}</dt>
                <dd>{moverValue(config)}</dd>
              </div>
            </dl>
          )}
        </div>
      </section>
      <section aria-labelledby="settings-pm-moves-title">
        <h3 id="settings-pm-moves-title" className={shared.groupTitle}>
          {t('settings.team.projectManagerMoves.title')}
        </h3>
        {can.manageTeam ? (
          <ProjectManagerMovesControls config={config} />
        ) : (
          <dl className={shared.facts}>
            <div>
              <dt>{t('settings.team.projectManagerMoves.label')}</dt>
              <dd>
                {t(`settings.team.projectManagerMoves.${projectManagerMovesOf(config)}`)}
                <p className={shared.help}>{t('settings.team.projectManagerMoves.help')}</p>
              </dd>
            </div>
          </dl>
        )}
      </section>
      <section aria-labelledby="settings-prerequisite-override-title">
        <h3 id="settings-prerequisite-override-title" className={shared.groupTitle}>
          {t('settings.team.prerequisiteOverride.title')}
        </h3>
        <div className={shared.controls}>
          <p id={prerequisiteHelpId} className={shared.help}>
            {t('settings.team.prerequisiteOverride.help')}
          </p>
          {can.manageTeam ? (
            <PrerequisiteOverrideControls config={config} helpId={prerequisiteHelpId} />
          ) : (
            <dl className={shared.facts}>
              <div>
                <dt>{t('settings.team.prerequisiteOverride.readOnlyLabel')}</dt>
                <dd>{t(`settings.team.prerequisiteOverride.value.${prerequisiteOverrideOf(config)}`)}</dd>
              </div>
            </dl>
          )}
        </div>
      </section>
      <section aria-labelledby="settings-pm-lifecycle-title">
        <h3 id="settings-pm-lifecycle-title" className={shared.groupTitle}>
          {t('settings.team.projectManagerLifecycle.label')}
        </h3>
        <div className={shared.controls}>
          <p id={lifecycleHelpId} className={shared.help}>
            {t('settings.team.projectManagerLifecycle.help')}
          </p>
          {can.manageTeam ? (
            <ProjectManagerLifecycleControls config={config} helpId={lifecycleHelpId} />
          ) : (
            <dl className={shared.facts}>
              <div>
                <dt>{t('settings.team.projectManagerLifecycle.question')}</dt>
                <dd className={shared.summaryBlock}>
                  {lifecycleValue(config).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  {projectManagerLifecycleOf(config).length === 0 ? (
                    <p>{t('settings.team.projectManagerLifecycle.none')}</p>
                  ) : null}
                </dd>
              </div>
            </dl>
          )}
        </div>
      </section>
      <section aria-labelledby="settings-priority-title">
        <h3 id="settings-priority-title" className={shared.groupTitle}>
          {t('settings.team.priority.label')}
        </h3>
        <div className={shared.controls}>
          <p id={priorityHelpId} className={shared.help}>
            {t('settings.team.priority.help')}
          </p>
          {can.manageTeam ? (
            <PriorityControls config={config} helpId={priorityHelpId} />
          ) : (
            <dl className={shared.facts}>
              <div>
                <dt>{t('settings.team.priority.readOnlyLabel')}</dt>
                <dd>{prioritySettersValue(config)}</dd>
              </div>
            </dl>
          )}
        </div>
      </section>
      <section aria-labelledby="settings-complexity-title">
        <h3 id="settings-complexity-title" className={shared.groupTitle}>
          {t('settings.team.complexity.label')}
        </h3>
        {can.manageTeam ? (
          <ComplexityControls config={config} />
        ) : (
          <div className={shared.controls}>
            <p className={shared.help}>{t('settings.team.complexity.help')}</p>
            <dl className={shared.facts}>
              <div>
                <dt>{t('settings.team.complexity.readOnlyLabel')}</dt>
                <dd>{complexityValue(config)}</dd>
              </div>
            </dl>
          </div>
        )}
      </section>
      <section aria-labelledby="settings-assignee-fit-title">
        <h3 id="settings-assignee-fit-title" className={shared.groupTitle}>
          {t('settings.team.assigneeFit.label')}
        </h3>
        <div className={shared.controls}>
          <p id={assigneeFitHelpId} className={shared.help}>
            {t('settings.team.assigneeFit.help')}
          </p>
          {can.manageTeam ? (
            <AssigneeFitControls config={config} helpId={assigneeFitHelpId} />
          ) : (
            <dl className={shared.facts}>
              <div>
                <dt>{t('settings.team.assigneeFit.readOnlyLabel')}</dt>
                <dd>
                  {config.team.assigneeFit === 'automatic_and_ai'
                    ? t('settings.team.assigneeFit.value.automaticAndAi')
                    : t('settings.team.assigneeFit.value.automatic')}
                </dd>
              </div>
            </dl>
          )}
        </div>
      </section>
      <section aria-labelledby="settings-merger-title">
        <h3 id="settings-merger-title" className={shared.groupTitle}>
          {t('settings.team.merger.label')}
        </h3>
        {can.manageTeam ? (
          <MergerControls config={config} />
        ) : (
          <dl className={shared.facts}>
            <div>
              <dt>{t('settings.team.merger.label')}</dt>
              <dd>
                {mergerValue(config)}
                <p className={shared.help}>{t('settings.team.merger.help')}</p>
              </dd>
            </div>
          </dl>
        )}
      </section>
      <section aria-labelledby="settings-contacts-title">
        <h3 id="settings-contacts-title" className={shared.groupTitle}>
          {t('settings.team.contacts.label')}
        </h3>
        {can.manageTeam ? (
          <>
            <ContactControls config={config} />
            <ViewerRecipientsControls config={config} />
          </>
        ) : (
          <dl className={shared.facts}>
            <div>
              <dt>{t('settings.team.contacts.label')}</dt>
              <dd>
                {contactsValue(config)}
                <p className={shared.help}>
                  <ContactsHint config={config} />
                </p>
              </dd>
            </div>
            <div>
              <dt>{t('settings.team.viewerRecipients.label')}</dt>
              <dd>
                {t(`settings.team.viewerRecipients.${viewerRecipientsOf(config)}`)}
                <p className={shared.help}>{t('settings.team.viewerRecipients.help')}</p>
                <ViewerRecipientsStatus config={config} />
              </dd>
            </div>
          </dl>
        )}
      </section>
    </SettingsSection>
  );
}

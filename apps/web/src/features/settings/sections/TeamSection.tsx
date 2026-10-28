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
        {t('settings.team.contacts.hint')}
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
  const { key, can } = useProject();
  const roles = useRoles(key);
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
          <ContactControls config={config} />
        ) : (
          <dl className={shared.facts}>
            <div>
              <dt>{t('settings.team.contacts.label')}</dt>
              <dd>
                {contactsValue(config)}
                <p className={shared.help}>{t('settings.team.contacts.hint')}</p>
              </dd>
            </div>
          </dl>
        )}
      </section>
    </SettingsSection>
  );
}

import { useState } from 'react';
import { Link } from 'react-router';
import {
  cardMerger,
  cardMoverHandle,
  cardMoverOf,
  hasAccess,
  isOperator,
  mergerOf,
} from '@projectman/shared';
import type { MemberConfig, ProjectConfig, RoleView } from '@projectman/shared';
import { isApiError } from '../../../api/client';
import { useRoles } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { Chip } from '../../../components/Chip';
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

/** The members who may merge: AI members (not the Operator) and humans with developer access or more. */
function mergerCandidates(config: ProjectConfig): MemberConfig[] {
  return config.team.members.filter(
    (member) => !isOperator(member) && (member.kind === 'ai' || hasAccess(member.access, 'developer')),
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
    </SettingsSection>
  );
}

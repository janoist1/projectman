import { useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DUTIES,
  DUTY_GROUPS,
  DUTY_IDS,
  BUILT_IN_ROLE_IDS,
  dutyMembers,
  introducedErrors,
  memberDuties,
  memberRoles,
  roleBundle,
  isBuiltInRole,
  ownerOnlyChanges,
  teamSettingOf,
  validateProjectConfig,
} from '@projectman/shared';
import type { DutyId, ProjectConfig } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { isApiError } from '../../api/client';
import { useConfig, usePatchConfig } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { LeaveChip } from '../../components/LeaveChip';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { issueMessage } from '../../lib/configIssues';
import { errorMessage } from '../../lib/errors';
import { useIsMobile } from '../../lib/hooks';
import { RoleForm } from '../team/RoleSection';
import { useInstantConfig } from './edit/useInstantConfig';
import { RoleTextEdit } from './RoleTextEdit';
import { resetRole, rolesBody, toggleDuty } from './rolesEdit';
import type { RoleTextField } from './rolesEdit';
import { SettingsSection } from './sections/SettingsSection';
import styles from './DutiesMatrix.module.css';

const ROLE_TEXTS: { field: RoleTextField; maxLength?: number }[] = [
  { field: 'summary', maxLength: 280 },
  { field: 'notTheirJob', maxLength: 200 },
  { field: 'whenToAsk', maxLength: 280 },
  { field: 'instructions' },
];

/** What a saved change tells in its toast, and how the undo names it. */
interface SaveNote {
  text: string;
  name: string;
}

/** How long a refusal stays at its cell when nothing else replaces it. */
const REFUSAL_MS = 8000;

/**
 * The roles and their duties. Every cell, the four-eyes switch and the reset of a role save the moment they
 * change (a change that would add an error is refused at its cell); each text of a role is saved on its own.
 */
export function DutiesMatrix({ config }: { config: ProjectConfig }) {
  const { key, isOwner, can } = useProject();
  const isMobile = useIsMobile();
  const toast = useToast();
  const query = useConfig(key);
  const patch = usePatchConfig(key);
  const describedBy = useId();
  const [people, setPeople] = useState(false);
  const [adding, setAdding] = useState(false);
  const [conflict, setConflict] = useState<{ author: string } | null>(null);
  const [refusal, setRefusal] = useState<{ cell: string; message: string } | null>(null);

  /** The undo of a save: only on the version that save made, so a later change by anyone is not overwritten. */
  const undo = (version: string, before: ProjectConfig, name: string) => {
    patch
      .mutateAsync(rolesBody(before, version, teamSettingOf(before, 'releaseFourEyes')))
      .then(() => toast.show(t('settings.pipeline.edit.undone', { name })))
      .catch(async (error: unknown) => {
        if (isApiError(error) && error.code === 'config_conflict') {
          await query.refetch();
          toast.show(t('settings.pipeline.edit.undoConflict'), 'error');
        } else toast.show(errorMessage(error), 'error');
      });
  };
  const instant = useInstantConfig<SaveNote>(config, {
    body: (next, saved) => rolesBody(next, saved.version, teamSettingOf(next, 'releaseFourEyes')),
    saved: (result, before, note) => {
      setRefusal(null);
      toast.show(note.text, 'ok', {
        action: {
          label: t('settings.pipeline.edit.undo'),
          run: () => undo(result.version, before.config, note.name),
        },
      });
    },
    refused: async (caught) => {
      if (isApiError(caught) && caught.code === 'config_conflict') {
        const fresh = (await query.refetch()).data;
        setConflict({ author: fresh?.history[0]?.author ?? '' });
      } else toast.show(errorMessage(caught), 'error');
    },
  });
  const shown = instant.shown;

  useEffect(() => {
    if (!refusal) return;
    const timer = setTimeout(() => setRefusal(null), REFUSAL_MS);
    return () => clearTimeout(timer);
  }, [refusal]);

  const locale = getLocale(config.project.language);
  const used = new Set(shown.team.members.flatMap(memberRoles));
  const roles = [...BUILT_IN_ROLE_IDS.filter((id) => used.has(id)), ...shown.team.roles.map((r) => r.id)];
  const holders = (role: string) => shown.team.members.filter((m) => memberRoles(m).includes(role));
  const holderNames = (role: string) =>
    holders(role)
      .map((m) => m.displayName)
      .join(', ') || t('duties.missing');
  const name = (role: string) =>
    isBuiltInRole(role)
      ? locale.roles[role].name
      : (shown.team.roles.find((r) => r.id === role)?.name ?? role);

  /**
   * Saves `update` unless it would add an error (the cell says why) or change what only an owner may;
   * `cell` says where a refusal is shown.
   */
  const attempt = (update: (draft: ProjectConfig) => void, note: SaveNote, cell: string) => {
    const before = instant.base();
    const probe = structuredClone(before);
    update(probe);
    if (!isOwner && ownerOnlyChanges(before, probe).length > 0) return;
    const [first] = introducedErrors(before, probe);
    if (first) {
      setRefusal({ cell, message: t('duties.refused', { reason: issueMessage(first) }) });
      return;
    }
    setConflict(null);
    void instant.commit(update, note);
  };
  const toggle = (role: string, duty: DutyId) =>
    attempt(
      (draft) => toggleDuty(draft, role, duty),
      {
        text: t('duties.saved', { role: name(role), duty: locale.duties[duty].name }),
        name: `${name(role)} · ${locale.duties[duty].name}`,
      },
      `${role}:${duty}`,
    );

  /** The cells an admin who is not an owner may not change (the same rule the server applies). */
  const ownerLocked = useMemo(() => {
    const cells = new Set<string>();
    if (isOwner || !can.manageTeam) return cells;
    for (const role of roles)
      for (const duty of DUTY_IDS) {
        const probe = structuredClone(shown);
        toggleDuty(probe, role, duty);
        if (ownerOnlyChanges(shown, probe).length > 0) cells.add(`${role}:${duty}`);
      }
    return cells;
  }, [shown, isOwner, can.manageTeam]);
  /** Why one box cannot be changed; a viewer gets one note above the matrix instead. */
  const lockOf = (role: string, duty: DutyId): 'owner' | 'human' | null => {
    if (!can.manageTeam) return null;
    if (ownerLocked.has(`${role}:${duty}`)) return 'owner';
    return DUTIES[duty].holders === 'human' &&
      (holders(role).some((m) => m.kind === 'ai') || shown.team.limits.tempWorkers.role === role)
      ? 'human'
      : null;
  };

  const issues = validateProjectConfig(shown);
  const hasOverride = (role: string) => isBuiltInRole(role) && !!shown.team.roleOverrides?.[role];
  const resetDisabled = (role: string) => {
    if (!can.manageTeam) return true;
    if (isOwner) return false;
    const probe = structuredClone(shown);
    resetRole(probe, role);
    return ownerOnlyChanges(shown, probe).length > 0;
  };
  const resetButton = (role: string) => (
    <Button
      size="sm"
      variant="secondary"
      disabled={resetDisabled(role)}
      onClick={() =>
        attempt(
          (draft) => resetRole(draft, role),
          { text: t('duties.resetDone', { role: name(role) }), name: name(role) },
          `reset:${role}`,
        )
      }
    >
      {t('duties.reset')}
    </Button>
  );
  const refusalAt = (cell: string) =>
    refusal?.cell === cell ? (
      <small id={`${describedBy}-${cell}`} role="alert" className={styles.refusal}>
        {refusal.message}
      </small>
    ) : null;

  const dutyBox = (role: string, id: DutyId) => {
    const lock = lockOf(role, id);
    const cell = `${role}:${id}`;
    const checked = roleBundle(shown, role).duties.includes(id);
    if (lock === 'owner')
      return (
        <span className={styles.lock} title={t('duties.ownerOnly')}>
          <Icon name="lock" size={14} />
          <input
            type="checkbox"
            checked={checked}
            disabled
            aria-label={t('duties.lockedLabel', { duty: locale.duties[id].name, role: name(role) })}
          />
          <span className="visually-hidden">{checked ? t('duties.lockedOn') : t('duties.lockedOff')}</span>
        </span>
      );
    return (
      <input
        type="checkbox"
        aria-label={`${locale.duties[id].name}: ${name(role)}`}
        aria-describedby={refusal?.cell === cell ? `${describedBy}-${cell}` : undefined}
        checked={checked}
        disabled={!can.manageTeam || lock === 'human'}
        onChange={() => toggle(role, id)}
      />
    );
  };
  const lockNote = (role: string, id: DutyId) => {
    const lock = lockOf(role, id);
    return lock ? <small>{lock === 'owner' ? t('duties.ownerOnly') : t('duties.humanOnly')}</small> : null;
  };

  const textEdit = (role: string, field: RoleTextField, maxLength: number | undefined, card: boolean) => (
    <RoleTextEdit
      config={shown}
      locale={locale}
      role={role}
      roleName={name(role)}
      field={field}
      label={field === 'instructions' ? t('duties.extra') : t(`roleCatalogue.${field}`)}
      maxLength={maxLength}
      disabled={!can.manageTeam}
      card={card}
    />
  );

  const columnCount = people ? shown.team.members.length : roles.length;
  const table = (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t('duties.duty')}</th>
            {people
              ? shown.team.members.map((m) => (
                  <th key={m.handle}>
                    {m.displayName}
                    <span className={styles.leaveMark}>
                      <LeaveChip member={m} />
                    </span>
                    <small>{m.handle}</small>
                  </th>
                ))
              : roles.map((role) => (
                  <th key={role}>
                    {name(role)}
                    <small>{holderNames(role)}</small>
                    {hasOverride(role) && resetButton(role)}
                    {refusalAt(`reset:${role}`)}
                  </th>
                ))}
          </tr>
        </thead>
        {DUTY_GROUPS.map((group) => (
          <tbody key={group}>
            <tr>
              <th colSpan={1 + columnCount} className={styles.group}>
                <span className={styles.groupLabel}>{t(`duties.${group}`)}</span>
              </th>
            </tr>
            {DUTY_IDS.filter((id) => DUTIES[id].group === group).map((id) => {
              const orphan = dutyMembers(shown, id).length === 0;
              return (
                <tr key={id} className={orphan ? styles.orphan : undefined}>
                  <th scope="row">
                    {locale.duties[id].name}
                    <small>{locale.duties[id].description}</small>
                    {orphan && <small>{t('duties.missing')}</small>}
                  </th>
                  {people
                    ? shown.team.members.map((m) => (
                        <td key={m.handle}>
                          <input
                            type="checkbox"
                            checked={memberDuties(shown, m).includes(id)}
                            readOnly
                            disabled
                            aria-label={`${locale.duties[id].name}: ${m.displayName}`}
                          />
                        </td>
                      ))
                    : roles.map((role) => {
                        const lock = lockOf(role, id);
                        return (
                          <td
                            key={role}
                            className={lock ? styles.disabled : undefined}
                            title={lock === 'owner' ? t('duties.ownerOnly') : undefined}
                          >
                            {dutyBox(role, id)}
                            {lockNote(role, id)}
                            {refusalAt(`${role}:${id}`)}
                          </td>
                        );
                      })}
                </tr>
              );
            })}
          </tbody>
        ))}
        {!people && (
          <tbody>
            {ROLE_TEXTS.map(({ field, maxLength }) => (
              <tr key={field}>
                <th scope="row">
                  {field === 'instructions' ? t('duties.extra') : t(`roleCatalogue.${field}`)}
                  {field !== 'instructions' && roles.some(isBuiltInRole) ? (
                    <small>{t('roleCatalogue.defaultText')}</small>
                  ) : null}
                </th>
                {roles.map((role) => (
                  <td key={role}>{textEdit(role, field, maxLength, false)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );

  /** A card's always-visible line: a chevron that turns when it opens, the name, a quieter line below. */
  const summary = (title: string, below: string, mark?: ReactNode) => (
    <summary>
      <Icon name="chevronRight" size={14} strokeWidth={2.4} className={styles.chevron} />
      <span className={styles.summaryText}>
        <span className={styles.roleName}>
          {title}
          {mark ? <span className={styles.leaveInline}>{mark}</span> : null}
        </span>
        <small>{below}</small>
      </span>
    </summary>
  );

  /** On a phone: one folding card per role (or per person), the duties as a list of checkboxes. */
  const cards = (
    <div className={styles.cards}>
      {people
        ? shown.team.members.map((m) => {
            const held = DUTY_IDS.filter((id) => memberDuties(shown, m).includes(id));
            return (
              <details key={m.handle} className={styles.roleCard}>
                {summary(m.displayName, m.handle, <LeaveChip member={m} />)}
                {held.length > 0 ? (
                  <ul className={styles.heldDuties}>
                    {held.map((id) => (
                      <li key={id}>{locale.duties[id].name}</li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.heldNone}>{t('common.dash')}</p>
                )}
              </details>
            );
          })
        : roles.map((role) => (
            <details key={role} className={styles.roleCard}>
              {summary(name(role), holderNames(role))}
              <div className={styles.roleBody}>
                {hasOverride(role) && (
                  <div>
                    {resetButton(role)}
                    {refusalAt(`reset:${role}`)}
                  </div>
                )}
                {DUTY_GROUPS.map((group) => (
                  <fieldset key={group} className={styles.dutyGroup}>
                    <legend>{t(`duties.${group}`)}</legend>
                    {DUTY_IDS.filter((id) => DUTIES[id].group === group).map((id) => {
                      // The whole row is the checkbox's label, so the name is a finger-sized target.
                      return (
                        <label
                          key={id}
                          className={lockOf(role, id) ? styles.dutyRowDisabled : styles.dutyRow}
                        >
                          {dutyBox(role, id)}
                          <span>
                            {locale.duties[id].name}
                            <small>{locale.duties[id].description}</small>
                            {lockNote(role, id)}
                            {refusalAt(`${role}:${id}`)}
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
                {ROLE_TEXTS.map(({ field, maxLength }) => (
                  <div key={field}>{textEdit(role, field, maxLength, true)}</div>
                ))}
              </div>
            </details>
          ))}
    </div>
  );

  const conflictName = conflict
    ? (shown.team.members.find((member) => member.handle === conflict.author)?.displayName ?? conflict.author)
    : '';

  return (
    <SettingsSection id="settings-duties" title={t('duties.title')}>
      <div className={styles.actions}>
        <SegmentedControl<'roles' | 'people'>
          label={t('duties.title')}
          size="sm"
          options={[
            { value: 'roles', label: t('duties.roles') },
            { value: 'people', label: t('duties.people') },
          ]}
          value={people ? 'people' : 'roles'}
          onChange={(view) => setPeople(view === 'people')}
        />
        {can.manageTeam && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            {t('duties.add')}
          </Button>
        )}
      </div>
      {can.manageTeam ? null : <p className={styles.note}>{t('duties.readOnly')}</p>}
      {conflict ? (
        <p className={styles.band} role="status">
          {conflictName ? t('duties.conflict', { name: conflictName }) : t('duties.conflictUnknown')}
        </p>
      ) : null}
      {isMobile ? cards : table}
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={teamSettingOf(shown, 'releaseFourEyes')}
          disabled={!isOwner}
          onChange={(event) => {
            const on = event.target.checked;
            attempt(
              (draft) => {
                draft.team.releaseFourEyes = on;
              },
              { text: t(on ? 'duties.fourEyesOn' : 'duties.fourEyesOff'), name: t('duties.fourEyes') },
              'fourEyes',
            );
          }}
        />
        {t('duties.fourEyes')}
      </label>
      {refusalAt('fourEyes')}
      {issues
        .filter((i) => i.detail && DUTY_IDS.includes(i.detail as DutyId))
        .map((issue, i) => (
          <p key={i} role={issue.severity === 'warning' ? 'status' : 'alert'}>
            {locale.duties[issue.detail as DutyId].name}: {t('duties.missing')}
          </p>
        ))}
      {adding ? <RoleForm onDone={() => setAdding(false)} /> : null}
    </SettingsSection>
  );
}

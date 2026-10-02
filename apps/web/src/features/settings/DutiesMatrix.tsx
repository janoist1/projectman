import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  DUTIES,
  DUTY_GROUPS,
  DUTY_IDS,
  BUILT_IN_ROLE_IDS,
  dutyMembers,
  memberDuties,
  memberRoles,
  roleBundle,
  isBuiltInRole,
  validateProjectConfig,
} from '@projectman/shared';
import type { DutyId, ProjectConfig } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { usePatchConfig } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { TextAreaField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { LeaveChip } from '../../components/LeaveChip';
import { SegmentedControl } from '../../components/SegmentedControl';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useIsMobile } from '../../lib/hooks';
import { RoleForm } from '../team/RoleSection';
import { useReportUnsaved } from './SettingsEditor';
import { SettingsSection } from './sections/SettingsSection';
import styles from './DutiesMatrix.module.css';

type RoleTextField = 'summary' | 'notTheirJob' | 'whenToAsk';
const ROLE_TEXTS: { field: RoleTextField; maxLength: number }[] = [
  { field: 'summary', maxLength: 280 },
  { field: 'notTheirJob', maxLength: 200 },
  { field: 'whenToAsk', maxLength: 280 },
];

const isReleaseDuty = (duty: DutyId) => duty === 'release_approval' || duty === 'boundary_authorization';

export function DutiesMatrix({ config, version }: { config: ProjectConfig; version: string }) {
  const { key, isOwner, can } = useProject();
  const isMobile = useIsMobile();
  const save = usePatchConfig(key);
  const [draft, setDraft] = useState(() => structuredClone(config));
  const [people, setPeople] = useState(false);
  const [adding, setAdding] = useState(false);
  const locale = getLocale(config.project.language);
  const used = new Set(config.team.members.flatMap(memberRoles));
  const roles = [...BUILT_IN_ROLE_IDS.filter((id) => used.has(id)), ...draft.team.roles.map((r) => r.id)];
  const holders = (role: string) => draft.team.members.filter((m) => memberRoles(m).includes(role));
  const holderNames = (role: string) =>
    holders(role)
      .map((m) => m.displayName)
      .join(', ') || t('duties.missing');
  const name = (role: string) =>
    isBuiltInRole(role)
      ? locale.roles[role].name
      : (draft.team.roles.find((r) => r.id === role)?.name ?? role);
  const change = (role: string, update: (bundle: ReturnType<typeof roleBundle>) => void) => {
    const next = structuredClone(draft);
    const bundle = structuredClone(roleBundle(next, role));
    update(bundle);
    if (isBuiltInRole(role)) (next.team.roleOverrides ??= {})[role] = bundle;
    else
      Object.assign(
        next.team.roles.find((r) => r.id === role)!,
        bundle,
      );
    setDraft(next);
  };
  /** A built-in role shows its default text until the project writes its own. */
  const text = (role: string, field: RoleTextField) =>
    isBuiltInRole(role)
      ? (draft.team.roleOverrides?.[role]?.[field] ?? locale.roles[role][field])
      : (draft.team.roles.find((r) => r.id === role)?.[field] ?? '');
  const setText = (role: string, field: RoleTextField, value: string) => {
    if (!isBuiltInRole(role)) {
      const next = structuredClone(draft);
      next.team.roles.find((r) => r.id === role)![field] = value;
      setDraft(next);
      return;
    }
    change(role, (bundle) => {
      if (value === locale.roles[role][field]) delete bundle[field];
      else bundle[field] = value;
    });
  };
  const toggle = (role: string, duty: DutyId) =>
    change(role, (bundle) => {
      bundle.duties = bundle.duties.includes(duty)
        ? bundle.duties.filter((id) => id !== duty)
        : [...bundle.duties, duty];
    });
  /** Why one box is locked for an admin; a viewer gets one note above the matrix instead. */
  const reason = (role: string, duty: DutyId) => {
    if (!can.manageTeam) return '';
    if (isReleaseDuty(duty) && !isOwner) return t('duties.ownerOnly');
    if (
      DUTIES[duty].holders === 'human' &&
      (holders(role).some((m) => m.kind === 'ai') || draft.team.limits.tempWorkers.role === role)
    )
      return t('duties.humanOnly');
    return '';
  };
  const issues = validateProjectConfig(draft);
  const dirty = JSON.stringify(draft.team) !== JSON.stringify(config.team);
  useReportUnsaved(dirty);

  const hasOverride = (role: string) => isBuiltInRole(role) && !!draft.team.roleOverrides?.[role];
  const resetDisabled = (role: string) =>
    !can.manageTeam ||
    (!isOwner &&
      (roleBundle(draft, role).duties.some(isReleaseDuty) ||
        roleBundle({ team: { ...draft.team, roleOverrides: {} } }, role).duties.some(isReleaseDuty)));
  const resetButton = (role: string) => (
    <Button
      size="sm"
      variant="secondary"
      disabled={resetDisabled(role)}
      onClick={() => {
        if (!isBuiltInRole(role)) return;
        const next = structuredClone(draft);
        delete next.team.roleOverrides![role];
        setDraft(next);
      }}
    >
      {t('duties.reset')}
    </Button>
  );
  const dutyBox = (role: string, id: DutyId, why: string) => (
    <input
      type="checkbox"
      aria-label={`${locale.duties[id].name}: ${name(role)}`}
      checked={roleBundle(draft, role).duties.includes(id)}
      disabled={!can.manageTeam || !!why || save.isPending}
      onChange={() => toggle(role, id)}
    />
  );
  const instructions = (role: string) => roleBundle(draft, role).instructions;
  const setInstructions = (role: string, value: string) =>
    change(role, (bundle) => {
      bundle.instructions = value;
    });

  const columnCount = people ? draft.team.members.length : roles.length;
  const table = (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t('duties.duty')}</th>
            {people
              ? draft.team.members.map((m) => (
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
              const orphan = dutyMembers(draft, id).length === 0;
              return (
                <tr key={id} className={orphan ? styles.orphan : undefined}>
                  <th scope="row">
                    {locale.duties[id].name}
                    <small>{locale.duties[id].description}</small>
                    {orphan && <small>{t('duties.missing')}</small>}
                  </th>
                  {people
                    ? draft.team.members.map((m) => (
                        <td key={m.handle}>
                          <input
                            type="checkbox"
                            checked={memberDuties(draft, m).includes(id)}
                            readOnly
                            disabled
                            aria-label={`${locale.duties[id].name}: ${m.displayName}`}
                          />
                        </td>
                      ))
                    : roles.map((role) => {
                        const why = reason(role, id);
                        return (
                          <td key={role} className={why ? styles.disabled : undefined} title={why}>
                            {dutyBox(role, id, why)}
                            {why && <small>{why}</small>}
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
                  {t(`roleCatalogue.${field}`)}
                  {roles.some(isBuiltInRole) ? <small>{t('roleCatalogue.defaultText')}</small> : null}
                </th>
                {roles.map((role) => (
                  <td key={role}>
                    <textarea
                      aria-label={`${t(`roleCatalogue.${field}`)}: ${name(role)}`}
                      disabled={!can.manageTeam}
                      maxLength={maxLength}
                      placeholder={isBuiltInRole(role) ? locale.roles[role][field] : undefined}
                      value={text(role, field)}
                      onChange={(e) => setText(role, field, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">{t('duties.extra')}</th>
              {roles.map((role) => (
                <td key={role}>
                  <textarea
                    aria-label={`${t('duties.extra')}: ${name(role)}`}
                    disabled={!can.manageTeam}
                    value={instructions(role)}
                    onChange={(e) => setInstructions(role, e.target.value)}
                  />
                </td>
              ))}
            </tr>
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
        ? draft.team.members.map((m) => {
            const held = DUTY_IDS.filter((id) => memberDuties(draft, m).includes(id));
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
                {hasOverride(role) && <div>{resetButton(role)}</div>}
                {DUTY_GROUPS.map((group) => (
                  <fieldset key={group} className={styles.dutyGroup}>
                    <legend>{t(`duties.${group}`)}</legend>
                    {DUTY_IDS.filter((id) => DUTIES[id].group === group).map((id) => {
                      const why = reason(role, id);
                      // The whole row is the checkbox's label, so the name is a finger-sized target.
                      return (
                        <label key={id} className={why ? styles.dutyRowDisabled : styles.dutyRow}>
                          {dutyBox(role, id, why)}
                          <span>
                            {locale.duties[id].name}
                            <small>{locale.duties[id].description}</small>
                            {why && <small>{why}</small>}
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
                {ROLE_TEXTS.map(({ field, maxLength }) => (
                  <TextAreaField
                    key={field}
                    label={t(`roleCatalogue.${field}`)}
                    disabled={!can.manageTeam}
                    maxLength={maxLength}
                    placeholder={isBuiltInRole(role) ? locale.roles[role][field] : undefined}
                    value={text(role, field)}
                    onChange={(e) => setText(role, field, e.target.value)}
                  />
                ))}
                <TextAreaField
                  label={t('duties.extra')}
                  disabled={!can.manageTeam}
                  value={instructions(role)}
                  onChange={(e) => setInstructions(role, e.target.value)}
                />
              </div>
            </details>
          ))}
    </div>
  );

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
      {isMobile ? cards : table}
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={draft.team.releaseFourEyes ?? false}
          disabled={!isOwner || save.isPending}
          onChange={(e) => setDraft({ ...draft, team: { ...draft.team, releaseFourEyes: e.target.checked } })}
        />
        {t('duties.fourEyes')}
      </label>
      {issues
        .filter((i) => i.detail && DUTY_IDS.includes(i.detail as DutyId))
        .map((issue, i) => (
          <p key={i} role={issue.severity === 'warning' ? 'status' : 'alert'}>
            {locale.duties[issue.detail as DutyId].name}: {t('duties.missing')}
          </p>
        ))}
      {save.isError && <p role="alert">{errorMessage(save.error)}</p>}
      {can.manageTeam && dirty && (
        <div className={styles.saveBar}>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={issues.some((i) => i.severity !== 'warning')}
            onClick={() =>
              save.mutate({
                baseVersion: version,
                roleOverrides: draft.team.roleOverrides ?? {},
                roles: draft.team.roles,
                releaseFourEyes: draft.team.releaseFourEyes ?? false,
              })
            }
          >
            {t('memberEdit.save')}
          </Button>
          <Button variant="secondary" onClick={() => setDraft(structuredClone(config))}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
      {adding ? <RoleForm onDone={() => setAdding(false)} /> : null}
    </SettingsSection>
  );
}

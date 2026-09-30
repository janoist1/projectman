import { useState } from 'react';
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
import { Dialog } from '../../components/Dialog';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { RoleForm } from '../team/RoleSection';
import styles from './DutiesMatrix.module.css';

export function DutiesMatrix({ config, version }: { config: ProjectConfig; version: string }) {
  const { key, isOwner, can } = useProject();
  const save = usePatchConfig(key);
  const [draft, setDraft] = useState(() => structuredClone(config));
  const [people, setPeople] = useState(false);
  const [adding, setAdding] = useState(false);
  const locale = getLocale(config.project.language);
  const used = new Set(config.team.members.flatMap(memberRoles));
  const roles = [...BUILT_IN_ROLE_IDS.filter((id) => used.has(id)), ...draft.team.roles.map((r) => r.id)];
  const holders = (role: string) => draft.team.members.filter((m) => memberRoles(m).includes(role));
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
  const toggle = (role: string, duty: DutyId) =>
    change(role, (bundle) => {
      bundle.duties = bundle.duties.includes(duty)
        ? bundle.duties.filter((id) => id !== duty)
        : [...bundle.duties, duty];
    });
  const reason = (role: string, duty: DutyId) => {
    if (!can.manageTeam) return t('duties.readOnly');
    if (duty === 'release_approval' && !isOwner) return t('duties.ownerOnly');
    if (
      DUTIES[duty].holders === 'human' &&
      (holders(role).some((m) => m.kind === 'ai') || draft.team.limits.tempWorkers.role === role)
    )
      return t('duties.humanOnly');
    return '';
  };
  const issues = validateProjectConfig(draft);
  const dirty = JSON.stringify(draft.team) !== JSON.stringify(config.team);
  return (
    <section className={styles.card} aria-label={t('duties.title')}>
      <h2>{t('duties.title')}</h2>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => setPeople(!people)}>
          {people ? t('duties.roles') : t('duties.people')}
        </Button>
        {can.manageTeam && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            {t('duties.add')}
          </Button>
        )}
      </div>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('duties.duty')}</th>
              {people
                ? draft.team.members.map((m) => (
                    <th key={m.handle}>
                      {m.displayName}
                      <small>{m.handle}</small>
                    </th>
                  ))
                : roles.map((role) => (
                    <th key={role}>
                      {name(role)}
                      <small>
                        {holders(role)
                          .map((m) => m.displayName)
                          .join(', ') || t('duties.missing')}
                      </small>
                      {isBuiltInRole(role) && draft.team.roleOverrides?.[role] && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={
                            !can.manageTeam ||
                            (!isOwner &&
                              (roleBundle(draft, role).duties.includes('release_approval') ||
                                roleBundle(
                                  { team: { ...draft.team, roleOverrides: {} } },
                                  role,
                                ).duties.includes('release_approval')))
                          }
                          onClick={() => {
                            const next = structuredClone(draft);
                            delete next.team.roleOverrides![role];
                            setDraft(next);
                          }}
                        >
                          {t('duties.reset')}
                        </Button>
                      )}
                    </th>
                  ))}
            </tr>
          </thead>
          {DUTY_GROUPS.map((group) => (
            <tbody key={group}>
              <tr>
                <th
                  colSpan={1 + (people ? draft.team.members.length : roles.length)}
                  className={styles.group}
                >
                  {t(`duties.${group}`)}
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
                              <input
                                type="checkbox"
                                aria-label={`${locale.duties[id].name}: ${name(role)}`}
                                checked={roleBundle(draft, role).duties.includes(id)}
                                disabled={!!why || save.isPending}
                                onChange={() => toggle(role, id)}
                              />
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
              <tr>
                <th>{t('duties.extra')}</th>
                {roles.map((role) => (
                  <td key={role}>
                    <textarea
                      aria-label={`${t('duties.extra')}: ${name(role)}`}
                      disabled={!can.manageTeam}
                      value={roleBundle(draft, role).instructions}
                      onChange={(e) =>
                        change(role, (bundle) => {
                          bundle.instructions = e.target.value;
                        })
                      }
                    />
                  </td>
                ))}
              </tr>
            </tbody>
          )}
        </table>
      </div>
      <label>
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
        <div className={styles.actions}>
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
      <Dialog open={adding} onClose={() => setAdding(false)} title={t('duties.add')}>
        <RoleForm onDone={() => setAdding(false)} />
      </Dialog>
    </section>
  );
}

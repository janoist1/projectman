import {
  Approver,
  SelectablePermissionMode,
  approverBlocksProvider,
  outboundNetworkOf,
} from '@projectman/shared';
import type { AgentProvider, PermissionMode, MemberView, UpdateMemberRequest } from '@projectman/shared';
import { useUpdateMember } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Chip } from '../../components/Chip';
import { SelectField, CheckField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { networkHint } from './networkHint';
import styles from './PermissionLevelControl.module.css';

/** Explain provider-specific behavior for the selected mode, including read-only views. */
export function PermissionProviderNote({
  provider,
  mode,
}: {
  provider?: AgentProvider;
  mode?: PermissionMode;
}) {
  return provider === 'gemini' && (mode === 'auto' || mode === 'plan') ? (
    <span className={styles.providerNote}>{t(`permissionControls.providerNotes.gemini.${mode}`)}</span>
  ) : null;
}

/** The two permission settings as everyone but an owner sees them: no way to change them. */
function PermissionText({ member, provider }: { member: MemberView; provider?: AgentProvider }) {
  return (
    <span className={styles.control}>
      <span className={styles.line}>
        <span>
          {member.permissionMode ? t(`permissionModes.${member.permissionMode}`) : t('common.dash')}
        </span>
        {member.permissionLegacy ? <Chip>{t('permissionControls.legacy')}</Chip> : null}
        <span aria-hidden="true">·</span>
        <span>
          {member.approver ? t(`permissionControls.approvers.${member.approver}`) : t('common.dash')}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {t('permissionControls.networkState', {
            value: t(`permissionControls.networkValues.${outboundNetworkOf(member) ? 'on' : 'off'}`),
          })}
        </span>
      </span>
      {member.permissionLegacy ? (
        <span className={styles.note}>{t('permissionControls.legacyHint')}</span>
      ) : null}
      {approverBlocksProvider({ provider, approver: member.approver }) ? (
        <span className={styles.warning}>{t('permissionControls.nanogptApproverNone')}</span>
      ) : null}
      {!member.permissionLegacy ? (
        <PermissionProviderNote provider={provider} mode={member.permissionMode} />
      ) : null}
    </span>
  );
}

/**
 * The permission settings of an AI member: the mode (Kérdez, Szerkesztést elfogad, Auto, Tervezés)
 * and who answers when it asks (Ember, AI-döntnök, Senki). Only an owner gets the selectors; each
 * choice is saved at once (`PATCH` of the member). The AI approver is disabled, with the reason,
 * while the server says it cannot be chosen. Everyone else only reads the values.
 */
export function PermissionLevelControl({
  member,
  provider = member.provider,
}: {
  member: MemberView;
  provider?: AgentProvider;
}) {
  const { key, isOwner } = useProject();
  const update = useUpdateMember(key);
  const toast = useToast();
  if (member.kind !== 'ai') return null;
  if (!isOwner) return <PermissionText member={member} provider={provider} />;
  const blocker = member.aiApproverBlocker;
  const save = (body: UpdateMemberRequest, saved: string) =>
    update.mutate(
      { handle: member.handle, body },
      {
        onSuccess: () => toast.show(saved),
        onError: (error) => toast.show(errorMessage(error), 'error'),
      },
    );
  return (
    <span className={styles.control}>
      <SelectField
        label={t('permissionControls.mode')}
        value={member.permissionLegacy ? '' : (member.permissionMode ?? 'auto')}
        disabled={update.isPending}
        onChange={(event) => {
          const mode = SelectablePermissionMode.parse(event.target.value);
          save(
            { permissionMode: mode },
            t('permissionControls.savedMode', {
              name: member.displayName,
              value: t(`permissionModes.${mode}`),
            }),
          );
        }}
      >
        {member.permissionLegacy ? (
          <option value="" disabled>
            {t('permissionControls.legacy')}
          </option>
        ) : null}
        {SelectablePermissionMode.options.map((mode) => (
          <option key={mode} value={mode}>
            {t(`permissionModes.${mode}`)}
          </option>
        ))}
      </SelectField>
      {!member.permissionLegacy ? (
        <PermissionProviderNote provider={provider} mode={member.permissionMode ?? 'auto'} />
      ) : null}
      {member.permissionLegacy ? (
        <span className={styles.note}>{t('permissionControls.legacyHint')}</span>
      ) : null}
      <SelectField
        label={t('permissionControls.approver')}
        value={member.approver ?? 'human'}
        disabled={update.isPending}
        onChange={(event) => {
          const approver = Approver.parse(event.target.value);
          save(
            { approver },
            t('permissionControls.savedApprover', {
              name: member.displayName,
              value: t(`permissionControls.approvers.${approver}`),
            }),
          );
        }}
      >
        {Approver.options.map((approver) => (
          <option key={approver} value={approver} disabled={approver === 'ai' && blocker !== undefined}>
            {t(`permissionControls.approvers.${approver}`)}
          </option>
        ))}
      </SelectField>
      {blocker ? <span className={styles.note}>{t(`permissionControls.blocked.${blocker}`)}</span> : null}
      <CheckField
        label={t('permissionControls.network')}
        checked={outboundNetworkOf(member)}
        disabled={update.isPending}
        onChange={(checked) => {
          save(
            { outboundNetwork: checked },
            t('permissionControls.savedNetwork', {
              name: member.displayName,
              value: t(`permissionControls.networkValues.${checked ? 'on' : 'off'}`),
            }),
          );
        }}
        hint={networkHint({ network: outboundNetworkOf(member), provider, approver: member.approver })}
      />
      {approverBlocksProvider({ provider, approver: member.approver }) ? (
        <span className={styles.warning}>{t('permissionControls.nanogptApproverNone')}</span>
      ) : null}
    </span>
  );
}

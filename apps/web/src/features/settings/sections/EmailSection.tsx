import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import type {
  EmailChannelView,
  EmailContact,
  EmailLogEntry,
  EmailOutboundStatus,
  MemberView,
  ProjectConfig,
} from '@projectman/shared';
import {
  useEmailChannel,
  useEmailLog,
  useInvitations,
  useMembers,
  usePatchConfig,
  useRoles,
  useSetEmailContact,
} from '../../../api/queries';
import { queryKeys } from '../../../api/queryKeys';
import { useProject } from '../../../app/contexts';
import { Avatar } from '../../../components/Avatar';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import type { ChipTone } from '../../../components/Chip';
import { Dialog, DialogActions } from '../../../components/Dialog';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { ErrorState } from '../../../components/States';
import { useToast } from '../../../components/toastContext';
import { formatAgo, formatStamp } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import { isPendingInvite } from '../../invites/pendingInvites';
import { EditMemberDialog } from '../../team/EditMemberDialog';
import { InviteDialog } from '../../team/InviteDialog';
import shared from '../settings.module.css';
import styles from './EmailSection.module.css';
import { SettingsSection } from './SettingsSection';

/** Display names by handle: the whole team, since the log and the source lines also name members who no longer write. */
type Names = ReadonlyMap<string, string>;

function namesOf(view: EmailChannelView, members: readonly MemberView[] | undefined): Names {
  return new Map([
    ...(members ?? []).map((member) => [member.handle, member.displayName] as const),
    ...view.senders.map((sender) => [sender.handle, sender.displayName] as const),
    ...view.contacts.map((contact) => [contact.handle, contact.displayName] as const),
  ]);
}

/** Who is meant by a handle in the log; an unknown one shows as the handle. */
const nameOf = (names: Names, handle: string | null): string =>
  handle === null ? t('settings.email.log.unknownSender') : (names.get(handle) ?? handle);

const stateWord = (wants: boolean): string =>
  t(wants ? 'settings.email.contacts.on' : 'settings.email.contacts.off');

/** The small line under a switch: who changed it, how and when; null for a person nobody ever changed. */
function sourceLine(contact: EmailContact, names: Names, myHandle: string | null): string | null {
  if (!contact.changedAt) return null;
  const time = formatAgo(contact.changedAt);
  const state = stateWord(contact.wants);
  if (contact.source === 'complaint') return t('settings.email.contacts.byComplaint', { time });
  if (contact.source === 'email') return t('settings.email.contacts.byEmail', { state, time });
  if (contact.changedBy !== null && contact.changedBy === myHandle)
    return t('settings.email.contacts.bySelf', { state, time });
  const who = contact.changedBy !== null ? names.get(contact.changedBy) : undefined;
  if (!who) return t('settings.email.contacts.bySystem', { state, time });
  const requester =
    contact.requestedBy && contact.requestedBy !== contact.changedBy
      ? names.get(contact.requestedBy)
      : undefined;
  return requester
    ? t('settings.email.contacts.byMemberFor', { who, state, requester, time })
    : t('settings.email.contacts.byMember', { who, state, time });
}

/** The state of the channel switch; the save error reverts it and offers another try. */
function ChannelCard({ view, version }: { view: EmailChannelView; version: string }) {
  const { key } = useProject();
  const patch = usePatchConfig(key);
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const client = useQueryClient();
  const [lastTarget, setLastTarget] = useState(false);
  // True from the saved config until the channel view is read again, so the switch does not jump back.
  const [settling, setSettling] = useState(false);
  const target = patch.isPending || settling ? lastTarget : view.enabled;
  const aiCount = view.senders.length;
  const humanCount = view.contacts.filter((contact) => contact.wants).length;

  const save = (enabled: boolean): void => {
    setLastTarget(enabled);
    patch.mutate(
      { baseVersion: version, email: { enabled } },
      {
        onSuccess: () => {
          setConfirming(false);
          setSettling(true);
          toast.show(t('settings.email.saved'));
          void client
            .invalidateQueries({ queryKey: queryKeys.emailChannel(key) })
            .finally(() => setSettling(false));
        },
        onError: () => setConfirming(false),
      },
    );
  };
  const hintId = useId();

  return (
    <>
      <div className={styles.channel}>
        <input
          type="checkbox"
          role="switch"
          className={styles.switch}
          aria-label={t('settings.email.channel.label')}
          aria-describedby={hintId}
          checked={target}
          disabled={!view.configured && !view.enabled}
          onChange={(event) => (event.target.checked ? setConfirming(true) : save(false))}
        />
        <div className={styles.channelText}>
          <span className={shared.strong}>{t('settings.email.channel.label')}</span>
          <span id={hintId} className={shared.help}>
            {t('settings.email.channel.hint')}
          </span>
          {view.enabled && view.fromAddress ? (
            <span className={shared.muted}>
              {t('settings.email.channel.from', { address: view.fromAddress })}
            </span>
          ) : null}
        </div>
      </div>
      {!view.configured ? (
        <p role="status" className={styles.info}>
          {t('settings.email.channel.notConfigured')}
        </p>
      ) : null}
      {patch.error ? (
        <div className={styles.failure}>
          <ErrorBanner>{t('settings.email.saveFailed')}</ErrorBanner>
          <Button variant="secondary" size="md" loading={patch.isPending} onClick={() => save(lastTarget)}>
            {t('app.retry')}
          </Button>
        </div>
      ) : null}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('settings.email.channel.confirmTitle')}
        size="sm"
      >
        <p>{t('settings.email.channel.confirmBody', { ai: aiCount, humans: humanCount })}</p>
        <DialogActions>
          <Button type="button" variant="secondary" size="md" onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            loading={patch.isPending}
            onClick={() => save(true)}
          >
            {t('settings.email.channel.confirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function SendersBlock({
  view,
  members,
  onEdit,
}: {
  view: EmailChannelView;
  members: readonly MemberView[] | undefined;
  onEdit: (handle: string) => void;
}) {
  const { key } = useProject();
  return (
    <>
      {view.senders.length === 0 ? (
        <p className={shared.muted}>
          {t('settings.email.senders.none')}{' '}
          <Link to={`/p/${key}/team`}>{t('settings.email.senders.teamLink')}</Link>
        </p>
      ) : (
        <ul className={styles.senders}>
          {view.senders.map((sender) => (
            <li key={sender.handle} className={styles.sender}>
              <Avatar member={memberOf(members, sender.handle)} handle={sender.handle} size="md" />
              <span className={styles.senderText}>
                <span className={shared.strong}>{sender.displayName}</span>
                <span className={shared.muted}>
                  {t(
                    sender.sendWithoutApproval
                      ? 'settings.email.senders.noApproval'
                      : 'settings.email.senders.approval',
                  )}
                </span>
              </span>
              <Button
                variant="ghost"
                size="md"
                aria-label={t('settings.email.senders.editOf', { name: sender.displayName })}
                onClick={() => onEdit(sender.handle)}
              >
                {t('settings.email.senders.edit')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ContactsBlock({
  view,
  names,
  onInvite,
}: {
  view: EmailChannelView;
  names: Names;
  onInvite: (handle: string) => void;
}) {
  const { key, myHandle, can } = useProject();
  const set = useSetEmailContact(key);
  // While the list loads or fails, nobody shows as invited; the server refuses a second invitation anyway.
  const invitations = useInvitations(key, can.manageTeam);
  const invitedHandles = new Set(
    (invitations.data?.invitations ?? [])
      .filter(isPendingInvite)
      .flatMap((invite) => (invite.memberHandle ? [invite.memberHandle] : [])),
  );
  const toast = useToast();
  const nobody = view.enabled && !view.contacts.some((contact) => contact.wants);
  return (
    <>
      <p className={shared.help}>{t('settings.email.contacts.intro')}</p>
      {nobody ? (
        <p role="status" className={styles.info}>
          {t('settings.email.contacts.nobody')}
        </p>
      ) : null}
      <table className={styles.contacts}>
        <thead>
          <tr>
            <th scope="col">{t('settings.email.contacts.person')}</th>
            <th scope="col" className={styles.addressColumn}>
              {t('settings.email.contacts.address')}
            </th>
            <th scope="col">{t('settings.email.contacts.wants')}</th>
          </tr>
        </thead>
        <tbody>
          {view.contacts.map((contact) => {
            const pendingHere = set.isPending && set.variables?.handle === contact.handle;
            const wants = pendingHere ? set.variables.wants : contact.wants;
            const line = sourceLine(contact, names, myHandle);
            return (
              <tr key={contact.handle}>
                <td>
                  <span className={styles.person}>
                    <Avatar
                      member={{
                        handle: contact.handle,
                        displayName: contact.displayName,
                        kind: 'human',
                        role: contact.access,
                      }}
                      size="md"
                    />
                    <span className={styles.personText}>
                      <span className={shared.strong}>{contact.displayName}</span>
                      <span className={shared.muted}>{t(`roles.human.${contact.access}`)}</span>
                      {line ? <span className={styles.source}>{line}</span> : null}
                    </span>
                  </span>
                </td>
                <td className={styles.addressColumn}>
                  {contact.address ? (
                    <span className={styles.address}>{contact.address}</span>
                  ) : (
                    <span className={styles.noAddress}>
                      {invitedHandles.has(contact.handle) ? (
                        <>
                          <span className={shared.muted}>{t('settings.email.contacts.invited')}</span>
                          <Link
                            className={styles.pendingLink}
                            to={`/p/${key}/team`}
                            data-invited-link={contact.handle}
                          >
                            {t('settings.email.contacts.pendingLink')}
                          </Link>
                        </>
                      ) : (
                        <>
                          <span className={shared.muted}>{t('settings.email.contacts.noAddress')}</span>
                          <Button
                            variant="ghost"
                            size="md"
                            aria-label={t('settings.email.contacts.inviteOf', { name: contact.displayName })}
                            onClick={() => onInvite(contact.handle)}
                          >
                            {t('settings.email.contacts.invite')}
                          </Button>
                        </>
                      )}
                    </span>
                  )}
                </td>
                <td>
                  <input
                    type="checkbox"
                    role="switch"
                    className={styles.switch}
                    aria-label={t('settings.email.contacts.wantsOf', { name: contact.displayName })}
                    checked={wants}
                    disabled={set.isPending || (!contact.address && !contact.wants)}
                    onChange={(event) =>
                      set.mutate(
                        { handle: contact.handle, wants: event.target.checked },
                        { onSuccess: () => toast.show(t('settings.email.saved')) },
                      )
                    }
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {set.error ? <ErrorBanner>{errorMessage(set.error)}</ErrorBanner> : null}
    </>
  );
}

const STATUS_CHIP: Record<EmailOutboundStatus, { key: string; tone: ChipTone }> = {
  pending_approval: { key: 'pending_approval', tone: 'needs' },
  sending: { key: 'sending', tone: 'neutral' },
  sent: { key: 'sent', tone: 'ok' },
  rejected: { key: 'notSent', tone: 'neutral' },
  cancelled: { key: 'notSent', tone: 'neutral' },
  failed: { key: 'undeliverable', tone: 'blocked' },
  bounced: { key: 'undeliverable', tone: 'blocked' },
  complained: { key: 'undeliverable', tone: 'blocked' },
};

/** The chip text and tone of a log row. */
function chipOf(entry: EmailLogEntry): { label: string; tone: ChipTone } {
  if (entry.kind === 'setting') return { label: t('settings.email.log.status.setting'), tone: 'neutral' };
  if (entry.kind === 'inbound')
    return entry.status === 'parked'
      ? { label: t('settings.email.log.status.parked'), tone: 'outline' }
      : { label: t('settings.email.log.status.delivered'), tone: 'ok' };
  const chip = STATUS_CHIP[entry.status];
  return {
    label: t(`settings.email.log.status.${chip.key}` as 'settings.email.log.status.sent'),
    tone: chip.tone,
  };
}

const DIRECTION: Record<EmailLogEntry['kind'], string> = { outbound: '↗', inbound: '↙', setting: '⇄' };

function logTitle(entry: EmailLogEntry, names: Names): string {
  if (entry.kind !== 'setting') return entry.subject;
  return t(entry.wants ? 'settings.email.log.settingWants' : 'settings.email.log.settingNotWants', {
    name: nameOf(names, entry.contact),
  });
}

function logMeta(entry: EmailLogEntry, names: Names): string {
  const time = formatStamp(entry.at);
  if (entry.kind === 'setting')
    return `${t('settings.email.log.settingBy', { who: nameOf(names, entry.by), state: stateWord(entry.wants) })} · ${time}`;
  const from =
    entry.kind === 'outbound'
      ? nameOf(names, entry.member)
      : entry.contact
        ? nameOf(names, entry.contact)
        : entry.fromAddress;
  const to = entry.kind === 'outbound' ? nameOf(names, entry.contact) : nameOf(names, entry.member);
  return [t('settings.email.log.route', { from, to }), entry.taskKey, time].filter(Boolean).join(' · ');
}

/** What the expanded row tells: the text and what became of the mail. */
function LogDetail({ entry, names }: { entry: EmailLogEntry; names: Names }) {
  const { key } = useProject();
  const lines: string[] = [];
  if (entry.kind === 'outbound') {
    const decided = entry.decidedAt ? formatStamp(entry.decidedAt) : '';
    const decider = nameOf(names, entry.decidedBy);
    switch (entry.status) {
      case 'pending_approval':
        break;
      case 'rejected':
        lines.push(t('settings.email.log.detail.rejectedBy', { name: decider, time: decided }));
        if (entry.note) lines.push(t('settings.email.log.detail.reason', { note: entry.note }));
        lines.push(t('settings.email.log.detail.agentGot'));
        break;
      case 'cancelled':
        lines.push(t('settings.email.log.detail.cancelled'));
        break;
      default:
        lines.push(
          entry.decidedBy
            ? t('settings.email.log.detail.approvedBy', { name: decider, time: decided })
            : t('settings.email.log.detail.withoutApproval'),
        );
    }
    if (entry.status === 'sending') lines.push(t('settings.email.log.detail.sending'));
    if (entry.status === 'failed') lines.push(t('settings.email.log.detail.failed'));
    if (entry.status === 'bounced') lines.push(t('settings.email.log.detail.bounced'));
    if (entry.status === 'complained') lines.push(t('settings.email.log.detail.complained'));
    return (
      <div className={styles.detail}>
        <pre className={styles.mailText}>{entry.text}</pre>
        {entry.status === 'pending_approval' ? (
          <p>
            {t('settings.email.log.detail.waiting')}{' '}
            <Link to={`/p/${key}/inbox`}>{t('settings.email.log.detail.waitingLink')}</Link>
          </p>
        ) : null}
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    );
  }
  if (entry.kind === 'inbound') {
    return (
      <div className={styles.detail}>
        <pre className={styles.mailText}>{entry.text}</pre>
        {entry.attachmentNames.length > 0 ? (
          <p>{t('settings.email.log.detail.attachments', { names: entry.attachmentNames.join(', ') })}</p>
        ) : null}
        <p>
          {entry.status === 'parked' && entry.parkReason
            ? t(`inbox.email.parkReason.${entry.parkReason}`)
            : t('settings.email.log.detail.delivered', { name: nameOf(names, entry.member) })}
        </p>
      </div>
    );
  }
  const source =
    entry.source === 'email'
      ? t('settings.email.log.detail.sourceEmail')
      : entry.source === 'complaint'
        ? t('settings.email.log.detail.sourceComplaint')
        : t('settings.email.log.detail.sourceSettings');
  return (
    <div className={styles.detail}>
      {entry.quote ? <p>{t('settings.email.log.detail.quote', { quote: entry.quote })}</p> : null}
      <p>{source}</p>
    </div>
  );
}

function LogRow({ entry, names }: { entry: EmailLogEntry; names: Names }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const chip = chipOf(entry);
  return (
    <li className={styles.logRow}>
      <button
        type="button"
        className={styles.logHead}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.direction} aria-hidden="true">
          {DIRECTION[entry.kind]}
        </span>
        <span className={styles.srOnly}>{t(`settings.email.log.${entry.kind}`)}: </span>
        <span className={styles.logMain}>
          <span className={styles.logTitle}>{logTitle(entry, names)}</span>
          <span className={shared.muted}>{logMeta(entry, names)}</span>
        </span>
        <Chip tone={chip.tone}>{chip.label}</Chip>
      </button>
      <div id={detailId} hidden={!open}>
        {open ? <LogDetail entry={entry} names={names} /> : null}
      </div>
    </li>
  );
}

function LogBlock({ names }: { names: Names }) {
  const { key } = useProject();
  const log = useEmailLog(key);
  if (log.isPending) return <div className={styles.skeleton} aria-busy="true" />;
  if (log.isError)
    return (
      <ErrorState
        error={log.error}
        message={t('settings.email.loadFailed')}
        onRetry={() => void log.refetch()}
      />
    );
  const entries = log.data.pages.flatMap((page) => page.entries);
  return (
    <>
      <p className={shared.help}>{t('settings.email.log.intro')}</p>
      {entries.length === 0 ? (
        <p className={shared.muted}>{t('settings.email.log.empty')}</p>
      ) : (
        <ul className={styles.log}>
          {entries.map((entry) => (
            <LogRow key={`${entry.kind}-${entry.id}`} entry={entry} names={names} />
          ))}
        </ul>
      )}
      {log.isFetchNextPageError ? <ErrorBanner>{t('settings.email.log.loadMoreFailed')}</ErrorBanner> : null}
      {log.hasNextPage ? (
        <Button
          variant="ghost"
          size="md"
          loading={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {t('settings.email.log.loadMore')}
        </Button>
      ) : null}
    </>
  );
}

/** The `MemberView` of a handle, for the member dialog. */
function memberOf(members: readonly MemberView[] | undefined, handle: string | null): MemberView | null {
  return (handle && members?.find((member) => member.handle === handle)) || null;
}

/**
 * The e-mail channel (PM-892, PM-942): the project switch, the AI members who may write, the people who
 * ask for mail and the log. Owners and admins only.
 */
export function EmailSection({ config, version }: { config: ProjectConfig; version: string }) {
  const { key } = useProject();
  const channel = useEmailChannel(key);
  const members = useMembers(key);
  const roles = useRoles(key);
  const [editing, setEditing] = useState<string | null>(null);
  const [inviting, setInviting] = useState<string | null>(null);
  const invitee = memberOf(members.data, inviting);
  const title = t('settings.sections.email');
  if (channel.isPending)
    return (
      <SettingsSection id="settings-email" title={title}>
        <div className={styles.skeleton} aria-busy="true" />
      </SettingsSection>
    );
  if (channel.isError)
    return (
      <SettingsSection id="settings-email" title={title}>
        <ErrorState
          error={channel.error}
          message={t('settings.email.loadFailed')}
          onRetry={() => void channel.refetch()}
        />
      </SettingsSection>
    );
  const view = channel.data;
  const names = namesOf(view, members.data);
  return (
    <>
      <SettingsSection id="settings-email" title={title}>
        <ChannelCard view={view} version={version} />
      </SettingsSection>
      {view.enabled ? (
        <>
          <SettingsSection title={t('settings.email.senders.title')}>
            <SendersBlock view={view} members={members.data} onEdit={setEditing} />
          </SettingsSection>
          <SettingsSection title={t('settings.email.contacts.title')}>
            <ContactsBlock view={view} names={names} onInvite={setInviting} />
          </SettingsSection>
          <SettingsSection title={t('settings.email.log.title')}>
            <LogBlock names={names} />
          </SettingsSection>
        </>
      ) : null}
      <EditMemberDialog
        member={memberOf(members.data, editing)}
        config={config}
        roles={roles.data?.roles ?? []}
        onClose={() => setEditing(null)}
      />
      <InviteDialog
        open={invitee !== null}
        member={invitee ?? undefined}
        intro={invitee ? t('settings.email.contacts.inviteIntro', { name: invitee.displayName }) : undefined}
        onClose={() => setInviting(null)}
        // The invitation turns the row's button into a link; focus goes to that link.
        returnFocusFallback={() =>
          document.querySelector<HTMLElement>(`[data-invited-link="${invitee?.handle ?? ''}"]`)
        }
      />
    </>
  );
}

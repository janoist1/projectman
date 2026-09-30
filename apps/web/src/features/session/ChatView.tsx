import clsx from 'clsx';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatItem, InboxItem, InboxOption, ResolveInboxRequest } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import type { ButtonVariant } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { formatStamp, formatTime } from '../../i18n/format';
import { joinNames, t } from '../../i18n/t';
import { groupChatItems, toolPresentation } from '../../lib/chat';
import type { ChatBlock, ToolRow } from '../../lib/chat';
import {
  inboxHeading,
  isPositiveResolution,
  optionLabel,
  payloadCode,
  permissionCommand,
  resolutionLabel,
  resolverName,
  shortCommand,
} from '../../lib/inbox';
import { nameOf, namesOf, toneFor } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import { InboxCard } from '../inbox/InboxCard';
import styles from './ChatView.module.css';

export interface PendingMessage {
  id: string;
  text: string;
  failed: boolean;
}

export interface ChatViewProps {
  items: readonly ChatItem[];
  /** Handle of the AI member running the session. */
  sessionMember: string;
  members: MemberIndex;
  myHandle: string | null;
  pipeline?: PipelineIndex | null;
  /** Open inbox items raised in this session, shown inline at the end. */
  openItems?: readonly InboxItem[];
  /** Resolved permission requests of this session, shown as decision lines. */
  resolvedItems?: readonly InboxItem[];
  onResolve?: (item: InboxItem, body: ResolveInboxRequest) => void;
  resolvingId?: string | null;
  /** The session waits for a permission: its unanswered tool call shows that instead of "running". */
  awaitingPermission?: boolean;
  /** Messages sent from the composer that the transcript has not shown yet. */
  pending?: readonly PendingMessage[];
}

const variantFor: Record<InboxOption['style'], ButtonVariant> = {
  primary: 'primary',
  secondary: 'secondary',
  danger: 'danger',
};

const LONG_TEXT = 700;

function CollapsibleText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= LONG_TEXT) return <Markdown text={text} />;
  return (
    <div className={styles.collapsible}>
      <Markdown text={open ? text : `${text.slice(0, LONG_TEXT).trimEnd()}…`} />
      <button
        type="button"
        className={styles.more}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? t('session.chat.showLess') : t('session.chat.showMore')}
      </button>
    </div>
  );
}

function ToolRows({ rows, awaitingId }: { rows: ToolRow[]; awaitingId: string | null }) {
  return (
    <ul className={styles.tools} aria-label={t('session.chat.toolGroup')}>
      {rows.map((row) => {
        const { icon, label } = toolPresentation(row.call);
        const result = row.result;
        return (
          <li key={row.id} className={styles.toolRow}>
            <span className={styles.toolIcon} aria-hidden="true">
              <Icon name={icon} size={13} strokeWidth={2} />
            </span>
            <span className={styles.toolKind}>{label}</span>
            <span className={styles.toolArg} title={row.call?.summary}>
              {row.call?.summary ?? ''}
            </span>
            {result ? (
              <span className={clsx(styles.toolResult, !result.ok && styles.toolFailed)}>
                {result.ok
                  ? result.summary
                  : result.summary
                    ? `${t('session.chat.toolFailed')} · ${result.summary}`
                    : t('session.chat.toolFailed')}
              </span>
            ) : (
              <span
                className={clsx(
                  styles.toolResult,
                  row.id === awaitingId ? styles.toolAwaiting : styles.toolRunning,
                )}
              >
                {row.id === awaitingId ? t('session.chat.toolAwaiting') : t('session.chat.toolRunning')}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PermissionPrompt({
  item,
  onResolve,
  busy,
}: {
  item: InboxItem;
  onResolve?: (item: InboxItem, body: ResolveInboxRequest) => void;
  busy: boolean;
}) {
  const code = payloadCode(item);
  const titleId = `perm-${item.id}`;
  return (
    <section className={styles.permission} aria-labelledby={titleId}>
      <div className={styles.permissionHead}>
        <span className={styles.permissionIcon} aria-hidden="true">
          <Icon name="shieldCheck" size={17} strokeWidth={2} />
        </span>
        <h3 id={titleId} className={styles.permissionTitle}>
          {t('session.chat.permissionTitle')}
        </h3>
        <span className={styles.permissionMeta}>
          {formatTime(item.createdAt)} · {t('session.chat.permissionNote')}
        </span>
      </div>
      <p className={styles.permissionText}>{inboxHeading(item)}</p>
      {item.body ? <p className={styles.permissionBody}>{item.body}</p> : null}
      {code ? <code className={styles.permissionCode}>{code}</code> : null}
      <div className={styles.permissionActions}>
        {item.options.map((option) => (
          <Button
            key={option.id}
            variant={variantFor[option.style]}
            disabled={busy || !onResolve}
            onClick={() => onResolve?.(item, { optionId: option.id })}
          >
            {optionLabel(option)}
          </Button>
        ))}
      </div>
    </section>
  );
}

function renderBlock(block: ChatBlock, props: ChatViewProps, awaitingId: string | null): ReactNode {
  const { members, myHandle, sessionMember } = props;
  switch (block.type) {
    case 'assistant': {
      const member = members.get(sessionMember);
      return (
        <div key={block.id} className={styles.assistant}>
          <Avatar member={member} handle={sessionMember} size="md" />
          <div className={styles.assistantBody}>
            <span className={styles.meta}>
              <span className={styles.author}>{nameOf(sessionMember, members, myHandle)}</span> ·{' '}
              {formatStamp(block.ts)}
            </span>
            <CollapsibleText text={block.item.text} />
          </div>
        </div>
      );
    }
    case 'user':
      if (block.item.origin === 'brief') {
        return (
          <details key={block.id} className={styles.brief}>
            <summary>{t('session.chat.brief')}</summary>
            <Markdown text={block.item.text} />
          </details>
        );
      }
      return (
        <div key={block.id} className={styles.user}>
          <span className={styles.meta}>{formatStamp(block.ts)}</span>
          <div className={styles.userBubble}>
            <CollapsibleText text={block.item.text} />
          </div>
        </div>
      );
    case 'tools':
      return (
        <div key={block.id} className={styles.toolBlock}>
          <ToolRows rows={block.rows} awaitingId={awaitingId} />
        </div>
      );
    case 'team': {
      const { item } = block;
      if (item.direction === 'in') {
        const sender = members.get(item.from);
        return (
          <div key={block.id} className={styles.teamIn} data-tone={toneFor(sender)}>
            <div className={styles.teamHead}>
              <Avatar member={sender} handle={item.from} isMe={item.from === myHandle} size="sm" />
              <span className={styles.teamSender}>{nameOf(item.from, members, myHandle)}</span>
              <span className={styles.meta}>
                {t('session.chat.teamMessageIn')} · {formatStamp(block.ts)}
              </span>
            </div>
            <CollapsibleText text={item.text} />
          </div>
        );
      }
      return (
        <div key={block.id} className={styles.teamOut}>
          <div className={styles.teamHead}>
            <span className={styles.teamLabel}>{t('session.chat.teamMessageOut')}</span>
            <Icon name="arrowRight" size={13} strokeWidth={2} />
            <span className={styles.teamRecipients}>{joinNames(namesOf(item.to, members, myHandle))}</span>
            <span className={styles.meta}>· {formatStamp(block.ts)}</span>
          </div>
          <CollapsibleText text={item.text} />
        </div>
      );
    }
    case 'note':
      return (
        <p key={block.id} className={styles.note}>
          {block.item.text}
        </p>
      );
  }
}

/** Renders every chat item kind of a session, with inline permission prompts. */
export function ChatView(props: ChatViewProps) {
  const {
    items,
    sessionMember,
    members,
    myHandle,
    pipeline = null,
    openItems = [],
    resolvedItems = [],
    onResolve,
    resolvingId = null,
    pending = [],
  } = props;
  const blocks = groupChatItems(items, sessionMember);
  const lastPending = props.awaitingPermission
    ? [...blocks]
        .reverse()
        .flatMap((block) => (block.type === 'tools' ? [...block.rows].reverse() : []))
        .find((row) => row.call && !row.result)
    : undefined;
  const awaitingId = lastPending?.id ?? null;

  const entries: Array<{ ts: string; order: number; node: ReactNode }> = blocks.map((block, order) => ({
    ts: block.ts,
    order,
    node: renderBlock(block, props, awaitingId),
  }));
  resolvedItems.forEach((item, index) => {
    if (!item.resolution) return;
    const positive = isPositiveResolution(item);
    const summary = shortCommand(permissionCommand(item)) ?? item.title;
    entries.push({
      ts: item.resolution.at,
      order: blocks.length + index,
      node: (
        <p
          key={`decision-${item.id}`}
          className={clsx(styles.decision, positive ? styles.decisionOk : styles.decisionNo)}
        >
          <span className={styles.decisionIcon} aria-hidden="true">
            <Icon name={positive ? 'check' : 'close'} size={11} strokeWidth={3.2} />
          </span>
          {t('session.chat.decisionLine', {
            decision: resolutionLabel(item),
            summary,
            who: resolverName(item, members, myHandle),
            time: formatStamp(item.resolution.at),
          })}
        </p>
      ),
    });
  });
  entries.sort((a, b) => (a.ts === b.ts ? a.order - b.order : a.ts.localeCompare(b.ts)));

  const permissions = openItems.filter((item) => item.kind === 'permission');
  const others = openItems.filter((item) => item.kind !== 'permission');

  if (entries.length === 0 && pending.length === 0 && openItems.length === 0) {
    return <p className={styles.empty}>{t('session.chat.empty')}</p>;
  }

  return (
    <div className={styles.chat}>
      {entries.map((entry) => entry.node)}
      {pending.map((message) => (
        <div key={message.id} className={clsx(styles.user, styles.pending)}>
          <span className={clsx(styles.meta, message.failed && styles.failed)}>
            {message.failed ? t('session.composer.failed') : t('session.composer.pending')}
          </span>
          <div className={styles.userBubble}>
            <Markdown text={message.text} />
          </div>
        </div>
      ))}
      {permissions.map((item) => (
        <PermissionPrompt key={item.id} item={item} onResolve={onResolve} busy={resolvingId === item.id} />
      ))}
      {others.map((item) => (
        <InboxCard
          key={item.id}
          item={item}
          members={members}
          myHandle={myHandle}
          pipeline={pipeline}
          compact
          headingLevel={3}
          pending={resolvingId === item.id}
          onResolve={(target, body) => onResolve?.(target, body)}
        />
      ))}
    </div>
  );
}

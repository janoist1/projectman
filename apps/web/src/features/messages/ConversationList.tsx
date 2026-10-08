import clsx from 'clsx';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import type { RoleView } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { Chip } from '../../components/Chip';
import { LeaveChip } from '../../components/LeaveChip';
import { formatAge, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf, roleLabel } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { plainPreview } from './conversations';
import type { ConversationRow } from './conversations';
import styles from './ConversationList.module.css';

/** "14:20" for today, then "tegnap", "3 napja": the list's one short time. */
function rowTime(iso: string): string {
  const age = formatAge(iso);
  return age === t('time.today') ? formatTime(iso) : age;
}

export interface ConversationListProps {
  projectKey: string;
  rows: readonly ConversationRow[];
  /** Members with no conversation yet. */
  rest: readonly string[];
  members: MemberIndex;
  roles: readonly RoleView[] | undefined;
  myHandle: string | null;
  selected: string | null;
  /** Question titles of members who asked me something and wrote nothing else. */
  questionTitles: ReadonlyMap<string, string>;
  /** First use: no conversation anywhere yet. */
  intro: boolean;
  /** The member whose row takes the focus when the list opens. */
  focusPeer?: string | null;
}

/** The viewer's conversations, the most recently active first, then the members they have not written with. */
export function ConversationList({
  projectKey,
  rows,
  rest,
  members,
  roles,
  myHandle,
  selected,
  questionTitles,
  intro,
  focusPeer = null,
}: ConversationListProps) {
  const href = (peer: string) => `/p/${projectKey}/messages/with/${peer}`;
  const nav = useRef<HTMLElement>(null);
  // Coming back from a conversation the focus returns to its row.
  useEffect(() => {
    if (!focusPeer) return;
    // Compare instead of building a selector: a peer from the address may hold any character.
    const rowElements = nav.current?.querySelectorAll<HTMLElement>('[data-peer]') ?? [];
    for (const element of rowElements) {
      if (element.dataset.peer === focusPeer) {
        element.focus();
        break;
      }
    }
  }, [focusPeer]);
  return (
    <nav ref={nav} className={styles.list} aria-label={t('messages.list.label')}>
      {intro ? (
        <div className={styles.intro}>
          <h2 className={styles.introTitle}>{t('messages.list.introTitle')}</h2>
          <p className={styles.introBody}>{t('messages.list.introBody')}</p>
        </div>
      ) : null}
      {rows.map((row) => {
        const member = members.get(row.peer);
        const name = nameOf(row.peer, members, myHandle);
        const message = row.lastMessage;
        const text = message
          ? message.via
            ? `${t('involvement.integrator')}: ${plainPreview(message.body)}`
            : message.from === myHandle
              ? t('messages.list.you', { text: plainPreview(message.body) })
              : plainPreview(message.body)
          : (questionTitles.get(row.peer) ?? '');
        const label = [
          name,
          row.unreadCount ? t('messages.list.unreadCount', { count: row.unreadCount }) : null,
          row.asks ? t('messages.list.asksYou') : null,
        ]
          .filter(Boolean)
          .join(', ');
        return (
          <Link
            key={row.peer}
            to={href(row.peer)}
            data-peer={row.peer}
            className={clsx(styles.row, row.unreadCount > 0 && styles.unread)}
            aria-current={selected === row.peer ? 'true' : undefined}
            aria-label={label}
          >
            <Avatar member={member} handle={row.peer} size="lg" className={styles.avatar} />
            <span className={styles.name}>
              <span className={styles.nameText}>{name}</span>
              <LeaveChip member={member} />
            </span>
            <span className={styles.time}>{rowTime(row.lastAt)}</span>
            <span className={styles.preview}>{text}</span>
            <span className={styles.marks}>
              {row.asks ? <Chip tone="needs">{t('messages.list.asks')}</Chip> : null}
              {row.unreadCount ? (
                <span className={styles.count} aria-hidden="true">
                  {row.unreadCount}
                </span>
              ) : null}
            </span>
          </Link>
        );
      })}
      {rest.length > 0 ? (
        <>
          <h2 className={styles.head}>
            {rows.length ? t('messages.list.others') : t('messages.list.members')}
          </h2>
          {rest.map((peer) => {
            const member = members.get(peer);
            return (
              <Link
                key={peer}
                to={href(peer)}
                data-peer={peer}
                className={clsx(styles.row, styles.quiet)}
                aria-current={selected === peer ? 'true' : undefined}
              >
                <Avatar member={member} handle={peer} size="lg" className={styles.avatar} />
                <span className={styles.name}>
                  <span className={styles.nameText}>{nameOf(peer, members, myHandle)}</span>
                  <LeaveChip member={member} />
                </span>
                <span />
                <span className={styles.preview}>{roleLabel(member, roles)}</span>
                <span />
              </Link>
            );
          })}
        </>
      ) : null}
    </nav>
  );
}

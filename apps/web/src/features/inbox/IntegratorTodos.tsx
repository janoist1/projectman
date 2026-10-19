import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  INTEGRATOR_TODO_TIMEOUT_MS,
  isIntegratorInboxItem,
  questionPayloadOf,
  wasIntegratorInboxItem,
} from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { Icon } from '../../components/Icon';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { resolverName } from '../../lib/inbox';
import type { MemberIndex } from '../../lib/members';
import styles from './IntegratorTodos.module.css';

function useClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function waitingAge(openedAt: string, now: number): string {
  const minutes = Math.max(1, Math.floor((now - Date.parse(openedAt)) / 60_000));
  return t(minutes >= 60 ? 'inbox.integrator.ageHours' : 'inbox.integrator.ageMinutes', {
    count: minutes >= 60 ? Math.floor(minutes / 60) : minutes,
  });
}

function timeLeft(item: InboxItem, now: number): string {
  const ms = Date.parse(openedAtOf(item)) + INTEGRATOR_TODO_TIMEOUT_MS - now;
  if (ms <= 0) return t('inbox.integrator.soon');
  return ms >= 3_600_000
    ? t('inbox.integrator.hours', { count: Math.ceil(ms / 3_600_000) })
    : t('inbox.integrator.minutes', { count: Math.ceil(ms / 60_000) });
}

function openedAtOf(item: InboxItem): string {
  return typeof item.payload.integratorOpenedAt === 'string'
    ? item.payload.integratorOpenedAt
    : item.createdAt;
}

/** Display only: the hub is the sole authority that moves a todo to the owner. */
export function IntegratorTodoClock({ item }: { item: InboxItem }) {
  const now = useClock();
  const openedAt = openedAtOf(item);
  if (!openedAt) return null;
  const overdue = Date.parse(openedAt) + INTEGRATOR_TODO_TIMEOUT_MS <= now;
  return (
    <p className={styles.clock}>
      <Icon name="clock" size={14} />
      <time dateTime={openedAt}>
        {overdue ? t('inbox.integrator.overdue') : t('inbox.integrator.left', { left: timeLeft(item, now) })}
      </time>
    </p>
  );
}

export function IntegratorTodos({
  items,
  lingering,
  renderCard,
  members,
  myHandle,
}: {
  items: readonly InboxItem[];
  lingering: ReadonlyMap<string, 'closed' | 'refused'>;
  renderCard: (item: InboxItem) => ReactNode;
  members: MemberIndex;
  myHandle: string | null;
}) {
  const now = useClock();
  const open = items
    .filter((item) => isIntegratorInboxItem(item) && (item.state === 'open' || lingering.has(item.id)))
    .sort((a, b) => openedAtOf(a).localeCompare(openedAtOf(b)) || a.id.localeCompare(b.id));
  const today = new Date(now).toDateString();
  const closed = items
    .filter(
      (item) =>
        wasIntegratorInboxItem(item) &&
        item.state === 'resolved' &&
        !item.resolution?.rule &&
        ['todo_done', 'todo_cannot', 'replan', 'reassign', 'another_round'].includes(
          item.resolution?.optionId ?? '',
        ) &&
        new Date(item.resolution!.at).toDateString() === today,
    )
    .sort((a, b) => b.resolution!.at.localeCompare(a.resolution!.at) || a.id.localeCompare(b.id))
    .slice(0, 5);
  const pending = open.filter((item) => item.state === 'open');
  const oldest = pending[0];
  if (!open.length && !closed.length) return null;
  const openedAt = oldest ? openedAtOf(oldest) : null;
  const overdue = openedAt && Date.parse(openedAt) + INTEGRATOR_TODO_TIMEOUT_MS <= now;
  return (
    <details className={styles.group}>
      <summary className={styles.summary}>
        <Icon name="terminal" size={18} />
        <span className={styles.summaryText}>
          <span className={styles.title}>
            {pending.length
              ? t('inbox.integrator.titleCount', { count: pending.length })
              : t('inbox.integrator.title')}
          </span>
          <span className={styles.meta}>
            {oldest && openedAt ? (
              <time dateTime={openedAt}>
                {overdue
                  ? t('inbox.integrator.overdue')
                  : t(pending.length === 1 ? 'inbox.integrator.single' : 'inbox.integrator.oldest', {
                      age: waitingAge(openedAt, now),
                      left: timeLeft(oldest, now),
                    })}
              </time>
            ) : (
              t('inbox.integrator.closedOnly', { count: closed.length })
            )}
          </span>
        </span>
        <span className={styles.chevron}>
          <Icon name="chevronDown" size={16} />
        </span>
      </summary>
      <div className={styles.body}>
        <p className={styles.lead}>{t('inbox.integrator.lead')}</p>
        {open.map(renderCard)}
        {closed.length ? (
          <>
            <h3 className={styles.closedHeading}>{t('inbox.integrator.closedToday')}</h3>
            <ul className={styles.closed}>
              {closed.map((item) => (
                <li key={item.id}>
                  <Icon name={item.resolution!.optionId === 'todo_cannot' ? 'close' : 'check'} size={16} />
                  <div>
                    <strong>
                      {item.kind === 'decision'
                        ? t(
                            `inbox.resolutions.${item.resolution!.optionId as 'replan' | 'reassign' | 'another_round'}`,
                          )
                        : t(
                            item.resolution!.integratorTodo
                              ? item.resolution!.optionId === 'todo_done'
                                ? 'inbox.integrator.done'
                                : 'inbox.integrator.cannot'
                              : item.resolution!.optionId === 'todo_done'
                                ? 'inbox.integrator.doneByYou'
                                : 'inbox.integrator.cannotByYou',
                            { what: questionPayloadOf(item)?.screening?.todo?.what ?? item.title },
                          )}
                    </strong>
                    <div className={styles.meta}>
                      {[item.taskKey, resolverName(item, members, myHandle)].filter(Boolean).join(' · ')} ·{' '}
                      <time dateTime={item.resolution!.at}>{formatAgo(item.resolution!.at)}</time>
                    </div>
                    {item.resolution!.note?.trim() ? (
                      <p className={styles.lead}>
                        {t(
                          item.resolution!.optionId === 'todo_cannot'
                            ? 'inbox.integrator.reasonNote'
                            : item.resolution!.integratorTodo
                              ? 'inbox.integrator.resultNote'
                              : 'inbox.integrator.yourNote',
                          { note: item.resolution!.note!.trim() },
                        )}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </details>
  );
}

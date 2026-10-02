import clsx from 'clsx';
import { Fragment, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { isUnreadBy } from '@projectman/shared';
import type { TeamMessage } from '@projectman/shared';
import type { AllMessagesFilter } from '../../api/queryKeys';
import { useAllMessages, useBoard, useReadTeamMessages, useTeamThreads } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button, ButtonLink } from '../../components/Button';
import { Markdown } from '../../components/Markdown';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { formatDayHeading, formatStamp } from '../../i18n/format';
import { joinNames, t } from '../../i18n/t';
import { nameOf, namesOf } from '../../lib/members';
import { deliveryState, receiptsOf } from './receipts';
import { TaskChip } from './TaskChip';
import type { ThreadComposeRequest } from './ConversationThread';
import styles from './AllMessages.module.css';

/** The server's page of the list (`limit` of the request); a full page means older messages are not shown. */
const PAGE_LIMIT = 500;

/** The filters live in the URL, so a filtered view can be linked to: ?member=&task=&unread=1. */
export function filterFromParams(params: URLSearchParams): AllMessagesFilter {
  return {
    member: params.get('member') ?? '',
    task: params.get('task') ?? '',
    unread: params.get('unread') === '1',
  };
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Every message of the project under the filters: who wrote to whom, about what, and where it stands. Owner and admin only. */
export function AllMessages({ onCompose }: { onCompose: (request: ThreadComposeRequest) => void }) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const board = useBoard(key);
  const threads = useTeamThreads(key);
  const [params, setParams] = useSearchParams();
  const filter = filterFromParams(params);
  const feed = useAllMessages(key, filter, true);
  const readMessages = useReadTeamMessages(key);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const titles = useMemo(
    () => new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title])),
    [board.data],
  );
  const filtered = filter.member !== '' || filter.task !== '' || filter.unread;

  const update = (patch: Partial<AllMessagesFilter>) => {
    const next = { ...filter, ...patch };
    const query = new URLSearchParams();
    if (next.member) query.set('member', next.member);
    if (next.task) query.set('task', next.task);
    if (next.unread) query.set('unread', '1');
    setParams(query, { replace: true });
  };

  const toggle = (message: TeamMessage) => {
    const opening = !open.has(message.id);
    setOpen((current) => {
      const next = new Set(current);
      if (opening) next.add(message.id);
      else next.delete(message.id);
      return next;
    });
    // Opening a row is reading it.
    if (opening && isUnreadBy(message, myHandle)) readMessages.mutate([message.id]);
  };

  const memberOptions = [...members.values()].filter(
    (member) => member.status !== 'retired' || member.handle === filter.member,
  );
  const taskOptions = board.data?.tasks ?? [];
  const messages = useMemo(
    () => [...(feed.data?.messages ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [feed.data],
  );

  let lastDay = '';
  return (
    <div className={styles.all}>
      <div className={styles.filters} role="group" aria-label={t('messages.all.filtersLabel')}>
        <label className={styles.field}>
          <span>{t('messages.all.member')}</span>
          <select
            className={styles.select}
            value={filter.member}
            onChange={(event) => update({ member: event.target.value })}
          >
            <option value="">{t('messages.all.anyMember')}</option>
            {memberOptions.map((member) => (
              <option key={member.handle} value={member.handle}>
                {nameOf(member.handle, members, myHandle)}
              </option>
            ))}
            {filter.member && !members.has(filter.member) ? (
              <option value={filter.member}>{filter.member}</option>
            ) : null}
          </select>
        </label>
        <label className={styles.field}>
          <span>{t('messages.all.task')}</span>
          <select
            className={styles.select}
            value={filter.task}
            onChange={(event) => update({ task: event.target.value })}
          >
            <option value="">{t('messages.all.anyTask')}</option>
            {taskOptions.map((task) => (
              <option key={task.key} value={task.key}>
                {task.key} · {task.title}
              </option>
            ))}
            {filter.task && !titles.has(filter.task) ? (
              <option value={filter.task}>{filter.task}</option>
            ) : null}
          </select>
        </label>
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={filter.unread}
          onClick={() => update({ unread: !filter.unread })}
        >
          {t('messages.all.unread', { count: threads.data?.unreadCount ?? 0 })}
        </button>
        {filtered ? (
          <Button
            variant="ghost"
            size="md"
            className={styles.clear}
            onClick={() => setParams({}, { replace: true })}
          >
            {t('messages.all.clear')}
          </Button>
        ) : null}
      </div>

      <div className={styles.feed} role="feed" aria-label={t('messages.all.feed')} aria-busy={feed.isPending}>
        {feed.isPending ? (
          <LoadingState />
        ) : feed.isError ? (
          <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />
        ) : messages.length === 0 ? (
          <EmptyState
            icon="messages"
            title={filtered ? t('messages.all.noMatch') : t('messages.empty')}
            body={filtered ? undefined : t('messages.all.emptyBody')}
            action={
              filtered ? (
                <Button size="md" variant="secondary" onClick={() => setParams({}, { replace: true })}>
                  {t('messages.all.clear')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {messages.map((message) => {
              const day = dayKey(message.createdAt);
              const heading = day !== lastDay ? formatDayHeading(message.createdAt) : null;
              lastDay = day;
              const expanded = open.has(message.id);
              const unread = isUnreadBy(message, myHandle);
              const toMe = myHandle !== null && message.to.includes(myHandle);
              const counterpart =
                message.from === myHandle
                  ? (message.to.find((handle) => handle !== myHandle) ?? null)
                  : toMe
                    ? message.from
                    : null;
              const receipts = receiptsOf(message, members);
              return (
                <Fragment key={message.id}>
                  {heading ? <h2 className={styles.day}>{heading}</h2> : null}
                  <article className={clsx(styles.row, toMe && styles.toMe)}>
                    {unread ? (
                      <span className={styles.dot} role="img" aria-label={t('messages.unread')} />
                    ) : null}
                    <button
                      type="button"
                      className={styles.main}
                      aria-expanded={expanded}
                      onClick={() => toggle(message)}
                    >
                      <Avatar
                        member={members.get(message.from)}
                        handle={message.from}
                        isMe={message.from === myHandle}
                        size="md"
                        className={styles.avatar}
                      />
                      <span className={styles.names}>
                        {t('messages.fromTo', {
                          from: nameOf(message.from, members, myHandle),
                          to: joinNames(namesOf(message.to, members, myHandle)),
                        })}
                      </span>
                      <time className={styles.time} dateTime={message.createdAt}>
                        {formatStamp(message.createdAt)}
                      </time>
                      {expanded ? null : <span className={styles.preview}>{message.body}</span>}
                    </button>
                    <div className={styles.detail}>
                      {message.taskKey ? (
                        <TaskChip
                          projectKey={key}
                          taskKey={message.taskKey}
                          title={titles.get(message.taskKey)}
                        />
                      ) : null}
                      {expanded ? (
                        <>
                          <Markdown text={message.body} className={styles.body} />
                          <div className={styles.more}>
                            <span>
                              {receipts
                                .map(
                                  (receipt) =>
                                    `${nameOf(receipt.handle, members, myHandle)}: ${t(`messages.status.${deliveryState([receipt])}`)}`,
                                )
                                .join(' · ')}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                onCompose({
                                  to: [...new Set([message.from, ...message.to])].filter(
                                    (handle) => handle !== myHandle,
                                  ),
                                  task: message.taskKey ?? '',
                                })
                              }
                            >
                              {t('messages.reply')}
                            </Button>
                            {counterpart ? (
                              <ButtonLink
                                size="sm"
                                variant="ghost"
                                to={`/p/${key}/messages/with/${counterpart}`}
                                iconRight="chevronRight"
                              >
                                {t('messages.all.openConversation')}
                              </ButtonLink>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </div>
                  </article>
                </Fragment>
              );
            })}
            {messages.length >= PAGE_LIMIT ? (
              <p className={styles.foot}>{t('messages.all.limit', { count: PAGE_LIMIT })}</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

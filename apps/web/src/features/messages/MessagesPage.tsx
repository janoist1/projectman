import { useMemo, useState } from 'react';
import { useBoard, useReadTeamMessage, useTeamMessages, useUnreadTeamMessages } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { PageHeader } from '../../components/PageHeader';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle } from '../../lib/hooks';
import type { TeamMessage } from '@projectman/shared';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { errorMessage } from '../../lib/errors';
import { MessageComposer } from './MessageComposer';
import { unreadMessages } from './receipts';
import { MessageList } from './MessageList';
import styles from './MessagesPage.module.css';

type MessageFilter = 'all' | 'mine' | 'unread';

/** Who told whom what, across the whole team. */
export function MessagesPage() {
  const { key, myHandle, me } = useProject();
  const messages = useTeamMessages(key);
  const read = useReadTeamMessage(key);
  const access = me.projects.find((p) => p.key === key)?.access;
  const canSend = Boolean(access && ['owner', 'admin', 'developer', 'client'].includes(access));
  const [compose, setCompose] = useState<{ to: string[]; task: string } | null>(null);
  const reply = (message: TeamMessage) =>
    setCompose({
      to: [...new Set([message.from, ...message.to])].filter((h) => h !== myHandle),
      task: message.taskKey ?? '',
    });
  const board = useBoard(key);
  const { members } = useProjectIndexes(key);
  const [filter, setFilter] = useState<MessageFilter>('all');
  const unreadQuery = useUnreadTeamMessages(key, filter === 'unread');
  useDocumentTitle(t('messages.title'), board.data?.project.name);
  const titles = useMemo(
    () => new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title])),
    [board.data],
  );

  if (messages.isPending) return <LoadingState />;
  if (messages.isError) return <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />;

  const all = messages.data.messages;
  const mine = all.filter((message) => myHandle !== null && message.to.includes(myHandle));
  const unread = unreadQuery.data?.messages ?? unreadMessages(all, myHandle);
  const shown = filter === 'mine' ? mine : filter === 'unread' ? unread : all;

  return (
    <div className={styles.page}>
      <PageHeader hideTitleOnPhone title={t('messages.title')} subtitle={t('messages.subtitle')}>
        {canSend ? (
          <Button variant="primary" onClick={() => setCompose({ to: [], task: '' })}>
            {t('messages.new')}
          </Button>
        ) : null}
        <SegmentedControl<MessageFilter>
          label={t('messages.filtersLabel')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('messages.filters.all'), count: all.length },
            { value: 'mine', label: t('messages.filters.mine'), count: mine.length },
            {
              value: 'unread',
              label: t('messages.unread'),
              count: messages.data.unreadCount ?? unread.length,
            },
          ]}
        />
      </PageHeader>
      <section className={styles.panel}>
        {filter === 'unread' && unreadQuery.isError ? (
          <ErrorState error={unreadQuery.error} onRetry={() => void unreadQuery.refetch()} />
        ) : shown.length === 0 ? (
          <EmptyState icon="messages" title={t('messages.empty')} />
        ) : (
          <MessageList
            messages={shown}
            members={members}
            myHandle={myHandle}
            projectKey={key}
            taskTitles={titles}
            onReply={canSend ? reply : undefined}
            onRead={(id) => read.mutate(id)}
            readPending={read.isPending}
            groupByDay
          />
        )}
      </section>
      {read.error ? <p role="alert">{errorMessage(read.error)}</p> : null}
      <Dialog open={Boolean(compose)} title={t('messages.new')} onClose={() => setCompose(null)}>
        {compose ? (
          <MessageComposer
            initialTo={compose.to}
            initialTask={compose.task}
            onSent={() => setCompose(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

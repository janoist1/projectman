import { useMemo, useState } from 'react';
import { useBoard, useTeamMessages } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle } from '../../lib/hooks';
import { MessageList } from './MessageList';
import styles from './MessagesPage.module.css';

type MessageFilter = 'all' | 'mine';

/** "Üzenetfolyam": who told whom what, across the whole team. */
export function MessagesPage() {
  const { key, myHandle } = useProject();
  const messages = useTeamMessages(key);
  const board = useBoard(key);
  const { members } = useProjectIndexes(key);
  const [filter, setFilter] = useState<MessageFilter>('all');
  useDocumentTitle(t('messages.title'), board.data?.project.name);
  const titles = useMemo(
    () => new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title])),
    [board.data],
  );

  if (messages.isPending) return <LoadingState />;
  if (messages.isError) return <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />;

  const all = messages.data.messages;
  const mine = all.filter(
    (message) => myHandle !== null && (message.to.includes(myHandle) || message.from === myHandle),
  );
  const shown = filter === 'mine' ? mine : all;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titles}>
          <h1 className={styles.title}>{t('messages.title')}</h1>
          <p className={styles.subtitle}>{t('messages.subtitle')}</p>
        </div>
        <SegmentedControl<MessageFilter>
          label={t('messages.filtersLabel')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('messages.filters.all'), count: all.length },
            { value: 'mine', label: t('messages.filters.mine'), count: mine.length },
          ]}
        />
      </header>
      <section className={styles.panel}>
        {shown.length === 0 ? (
          <EmptyState icon="messages" title={t('messages.empty')} />
        ) : (
          <MessageList
            messages={shown}
            members={members}
            myHandle={myHandle}
            projectKey={key}
            taskTitles={titles}
            groupByDay
          />
        )}
      </section>
    </div>
  );
}

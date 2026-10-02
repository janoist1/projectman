import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Navigate, useMatch, useNavigate, useParams } from 'react-router';
import { canSeeAllTeamMessages } from '@projectman/shared';
import { useBoard, useInbox, useRoles, useTeamThreads } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import { AllMessages } from './AllMessages';
import { ConversationList } from './ConversationList';
import { ConversationThread } from './ConversationThread';
import type { ThreadComposeRequest } from './ConversationThread';
import { conversationRows, openQuestionsFrom } from './conversations';
import { MessageComposer } from './MessageComposer';
import styles from './MessagesPage.module.css';

type View = 'conversations' | 'all';

/**
 * The team's messages: the viewer's conversations, member by member (the base view), and for an
 * owner and an admin the whole project's messages under filters. Routes: /messages (the list, and on
 * a wide screen the latest conversation), /messages/with/:handle, /messages/all.
 */
export function MessagesPage() {
  const { key, myHandle, me } = useProject();
  const { handle: peerParam } = useParams();
  const isAll = useMatch('/p/:projectKey/messages/all') !== null;
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const board = useBoard(key);
  const roles = useRoles(key);
  const threads = useTeamThreads(key);
  const inbox = useInbox(key);
  const { members } = useProjectIndexes(key);
  const access = me.projects.find((p) => p.key === key)?.access;
  const canAll = access ? canSeeAllTeamMessages({ access }) : false;
  const canSend = Boolean(access && ['owner', 'admin', 'developer', 'client'].includes(access));
  const [compose, setCompose] = useState<ThreadComposeRequest | null>(null);
  useDocumentTitle(t('messages.title'), board.data?.project.name);

  const openQuestions = useMemo(
    () => (inbox.data?.items ?? []).filter((item) => item.kind === 'question' && item.state === 'open'),
    [inbox.data],
  );
  const { rows, rest } = useMemo(
    () =>
      conversationRows(
        threads.data?.threads ?? [],
        openQuestions.filter((item) => myHandle !== null && item.assignees.includes(myHandle)),
        members,
        myHandle,
      ),
    [threads.data, openQuestions, members, myHandle],
  );
  const questionTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const row of rows) {
      const first = openQuestionsFrom(inbox.data?.items, row.peer, myHandle)[0];
      if (first) titles.set(row.peer, first.title);
    }
    return titles;
  }, [rows, inbox.data, myHandle]);

  // Someone who may not see everything gets the conversations, whatever the address says.
  if (isAll && !canAll) return <Navigate to={`/p/${key}/messages`} replace />;

  const view: View = isAll ? 'all' : 'conversations';
  // A wide screen shows a conversation beside the list; a phone shows one or the other.
  const selected = peerParam ?? (isMobile ? null : (rows[0]?.peer ?? null));
  const inThread = isMobile && peerParam !== undefined && view === 'conversations';

  const header = (
    <PageHeader hideTitleOnPhone title={t('messages.title')} className={styles.header}>
      {canAll ? (
        <SegmentedControl<View>
          label={t('messages.views.label')}
          value={view}
          onChange={(next) => navigate(`/p/${key}/messages${next === 'all' ? '/all' : ''}`)}
          options={[
            { value: 'conversations', label: t('messages.views.conversations') },
            { value: 'all', label: t('messages.views.all') },
          ]}
          className={styles.views}
        />
      ) : null}
      {canSend ? (
        <Button variant="primary" onClick={() => setCompose({ to: [], task: '' })}>
          {t('messages.new')}
        </Button>
      ) : null}
    </PageHeader>
  );

  const list = threads.isPending ? (
    <div className={styles.listState}>
      <LoadingState />
    </div>
  ) : threads.isError ? (
    <div className={styles.listState}>
      <ErrorState error={threads.error} onRetry={() => void threads.refetch()} />
    </div>
  ) : (
    <ConversationList
      projectKey={key}
      rows={rows}
      rest={rest}
      members={members}
      roles={roles.data?.roles}
      myHandle={myHandle}
      selected={isMobile ? null : selected}
      questionTitles={questionTitles}
      intro={rows.length === 0}
    />
  );

  return (
    <div className={clsx(styles.page, inThread && styles.threadPage)}>
      {inThread ? null : header}
      {view === 'all' ? (
        <AllMessages onCompose={setCompose} />
      ) : (
        <div className={styles.chat}>
          {isMobile && inThread ? null : list}
          {isMobile && !inThread ? null : selected ? (
            <ConversationThread
              key={selected}
              peer={selected}
              roles={roles.data?.roles}
              onCompose={setCompose}
            />
          ) : (
            <div className={styles.pick}>
              <EmptyState icon="messages" title={t('messages.thread.pick')} />
            </div>
          )}
        </div>
      )}
      <Dialog open={compose !== null} title={t('messages.new')} onClose={() => setCompose(null)}>
        {compose ? (
          <MessageComposer
            initialTo={compose.to}
            initialTask={compose.task}
            onSent={() => setCompose(null)}
            onCancel={() => setCompose(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Outlet, useLocation, useMatch } from 'react-router';
import {
  InboxKind,
  handOnRequestOf,
  operatorApprovalOf,
  operatorKnowledgeApprovalOf,
  questionPayloadOf,
  isLinkedQuestion,
  isIntegratorTodo,
  wasIntegratorTodo,
} from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { useBoard, useConfig, useInbox, useResolveInbox, useRevokeBoundary } from '../../api/queries';
import { Button } from '../../components/Button';
import { ActorName } from '../../components/ActorName';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { formatAgo, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import {
  answerDeliveryText,
  askerStartToast,
  closedBySomeoneElse,
  decisionLine,
  approvalHintOf,
  decisionSubject,
  decisionToast,
  boundaryOf,
  detailsHrefFor,
  displayKindOf,
  handOnResolvedText,
  handOnToast,
  inboxItemDomId,
  isAssignedTo,
  isAutomaticDecision,
  isRecentDecision,
  newestFirst,
  resolutionMark,
  resolutionNote,
  resolverName,
} from '../../lib/inbox';
import type { DisplayKind, ResolutionMark } from '../../lib/inbox';
import { isApiError } from '../../api/client';
import { errorMessage } from '../../lib/errors';
import { refusalFactsOf } from '../../lib/merge';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import { DrawerBaseContext } from '../board/drawerBase';
import type { DrawerBase } from '../board/drawerBase';
import { moveErrorText } from '../board/moveTask';
import { isStaleError, operatorDecisionToast } from '../operator/OperatorApproval';
import { InboxCard } from './InboxCard';
import { IntegratorTodos } from './IntegratorTodos';
import { OperatorTrail } from './OperatorTrail';
import { FoldedCommand } from './PermissionParts';
import { QuestionSources } from './QuestionSources';
import { ReleaseSubject } from './ReleaseInbox';
import styles from './InboxPage.module.css';

type KindFilter = 'all' | DisplayKind;

/** The kinds that get a pill, in order: a todo (PM-556) is a kind of its own, after the question. */
const FILTER_KINDS: readonly DisplayKind[] = [...InboxKind.options, 'todo'];

const MARK_STYLE: Record<ResolutionMark, string | undefined> = {
  ok: styles.recentOk,
  no: styles.recentNo,
  moot: styles.recentMoot,
  wait: styles.recentWait,
};

const MARK_ICON: Record<ResolutionMark, IconName> = {
  ok: 'check',
  no: 'close',
  moot: 'minus',
  wait: 'more',
};

/** How many decisions the system took by a rule are listed behind the folded row. */
const AUTOMATIC_LIST_LIMIT = 20;

function RecentRow({
  item,
  members,
  myHandle,
  pipeline,
  onRevoke,
}: {
  item: InboxItem;
  members: MemberIndex;
  myHandle: string | null;
  pipeline?: PipelineIndex | null | undefined;
  onRevoke?: ((id: string) => void) | undefined;
}) {
  const mark = resolutionMark(item);
  const group = questionPayloadOf(item)?.group;
  const note = resolutionNote(item);
  const delivery = answerDeliveryText(item, members, myHandle);
  const boundary = boundaryOf(item);
  const subject =
    item.kind === 'hand_on' && item.state === 'resolved'
      ? handOnResolvedText(item, members, myHandle, pipeline)
      : decisionSubject(item);
  return (
    <li className={styles.recentItem}>
      <span className={clsx(styles.recentIcon, MARK_STYLE[mark])} aria-hidden="true">
        <Icon name={MARK_ICON[mark]} size={12} strokeWidth={3} />
      </span>
      <div className={styles.recentText}>
        <span className={styles.recentLine}>{decisionLine(item, members, myHandle)}</span>
        {item.kind === 'permission' ? (
          <FoldedCommand text={subject} className={styles.recentCode} lines={1} />
        ) : item.kind === 'release' && item.taskKey ? (
          <span className={styles.recentSubject}>
            <ReleaseSubject taskKey={item.taskKey} title={item.title} />
          </span>
        ) : (
          <span className={styles.recentSubject}>{subject}</span>
        )}
        <span className={styles.recentMeta}>
          {item.resolution?.actor?.operatorMode === 'super' ? (
            <>
              <ActorName
                actor={item.resolution.actor}
                members={members}
                myHandle={myHandle}
                projectKey={item.projectKey}
              />{' '}
              · {formatAgo(item.resolution.at)}
            </>
          ) : item.resolution ? (
            t('inbox.resolvedBy', {
              who: resolverName(item, members, myHandle),
              time: formatAgo(item.resolution.at),
            })
          ) : (
            formatAgo(item.createdAt)
          )}
          {wasIntegratorTodo(item) ? ` · ${t('inbox.integrator.wasForIntegrator')}` : null}
          {group?.sources && item.state === 'resolved'
            ? ` · ${t('inbox.group.answeredCount', { count: group.answeredCount ?? group.sources.filter((s) => s.state === 'live').length })}`
            : null}
        </span>
        {group?.sources ? (
          <QuestionSources group={group} projectKey={item.projectKey} members={members} myHandle={myHandle} />
        ) : null}
        {note ? <span className={styles.recentNote}>{note}</span> : null}
        {delivery ? <span className={styles.recentNote}>{delivery}</span> : null}
        {boundary ? (
          <span className={styles.recentNote}>
            {boundary.consumedAt ? t('boundary.consumed') : t(`boundary.states.${boundary.state}`)}
            {boundary.invalidation ? ` · ${t(`boundary.reasons.${boundary.invalidation.reason}`)}` : ''}
          </span>
        ) : null}
        {onRevoke && boundary?.state === 'allowed' && !boundary.consumedAt ? (
          <Button variant="ghost" onClick={() => onRevoke(item.id)}>
            {t('boundary.revoke')}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * What the viewer decided lately. The permissions the system decided by a rule are not decisions of
 * the viewer: they are one folded row, so they do not push the real ones out.
 */
function RecentDecisions({
  items,
  automatic,
  members,
  myHandle,
  pipeline,
  onRevoke,
}: {
  items: InboxItem[];
  automatic: InboxItem[];
  members: MemberIndex;
  myHandle: string | null;
  pipeline?: PipelineIndex | null | undefined;
  onRevoke?: (id: string) => void;
}) {
  // Nothing decided yet: no empty box.
  if (items.length === 0 && automatic.length === 0) return null;
  return (
    <section className={styles.recent} aria-labelledby="inbox-recent">
      <h2 id="inbox-recent" className={styles.recentTitle}>
        {t('inbox.recent')}
      </h2>
      <ul className={styles.recentList}>
        {items.map((item) => (
          <RecentRow
            key={item.id}
            item={item}
            members={members}
            myHandle={myHandle}
            pipeline={pipeline}
            onRevoke={onRevoke}
          />
        ))}
      </ul>
      {automatic.length > 0 ? (
        <details className={styles.automatic}>
          <summary className={styles.automaticSummary}>
            {t('inbox.automaticDecisions', { count: automatic.length })}
          </summary>
          <ul className={styles.recentList}>
            {automatic.slice(0, AUTOMATIC_LIST_LIMIT).map((item) => (
              <RecentRow key={item.id} item={item} members={members} myHandle={myHandle} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** Everything that waits for the viewer, by kind. */
export function InboxPage() {
  const { key, myHandle, isOwner, can } = useProject();
  const isMobile = useIsMobile();
  const inbox = useInbox(key);
  const board = useBoard(key);
  const config = useConfig(key, can.readConfig).data?.config;
  const { members, pipeline } = useProjectIndexes(key);
  const resolve = useResolveInbox(key, myHandle);
  const revoke = useRevokeBoundary(key);
  const toast = useToast();
  const onRevoke = isOwner
    ? (id: string) => revoke.mutate(id, { onError: () => toast.show(t('boundary.revokeFailed'), 'error') })
    : undefined;
  const [filter, setFilter] = useState<KindFilter>('all');
  useDocumentTitle(t('inbox.title'), board.data?.project.name);

  const items = inbox.data?.items;
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash.startsWith('#inbox-item-')) return;
    const target = document.getElementById(hash.slice(1));
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }, [hash, items]);
  const mine = useMemo(
    () =>
      newestFirst(
        (items ?? []).filter(
          (item) => item.state === 'open' && !isLinkedQuestion(item) && isAssignedTo(item, myHandle),
        ),
      ),
    [items, myHandle],
  );
  const { recent, automatic } = useMemo(() => {
    const decided = (items ?? [])
      .filter(
        (item) =>
          !isLinkedQuestion(item) &&
          isRecentDecision(item) &&
          (item.resolution?.by === myHandle || isAssignedTo(item, myHandle)),
      )
      .sort((a, b) => (b.resolution?.at ?? b.createdAt).localeCompare(a.resolution?.at ?? a.createdAt));
    return {
      recent: decided.filter((item) => !isAutomaticDecision(item)).slice(0, 8),
      automatic: decided.filter(isAutomaticDecision),
    };
  }, [items, myHandle]);
  const titles = useMemo(
    () => new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title])),
    [board.data],
  );

  // A question that closes while it is open (its card finished, the asker left it, someone else answered)
  // stays in the list as a notice until the viewer dismisses it, so a half-typed answer is not lost (PM-556).
  // `closed`: it closed by itself; `refused`: the viewer's own answer was refused because it had closed.
  const [lingering, setLingering] = useState<ReadonlyMap<string, 'closed' | 'refused'>>(new Map());
  const shownOpen = useRef<Set<string>>(new Set());
  useEffect(() => {
    const gone = (items ?? []).filter(
      (item) =>
        item.kind === 'question' && shownOpen.current.has(item.id) && closedBySomeoneElse(item, myHandle),
    );
    if (gone.length > 0)
      setLingering((current) => {
        const next = new Map(current);
        for (const item of gone) if (!next.has(item.id)) next.set(item.id, 'closed');
        return next.size === current.size ? current : next;
      });
    shownOpen.current = new Set(
      (items ?? [])
        .filter(
          (item) =>
            item.state === 'open' && (isAssignedTo(item, myHandle) || (isOwner && isIntegratorTodo(item))),
        )
        .map((item) => item.id),
    );
  }, [items, mine, myHandle, isOwner]);
  const dismissGone = (id: string) => {
    // The focus goes on to the title of the next card (the previous one when it was the last), so it does not
    // fall to the page. A notice that goes away on its own, with the focus elsewhere, leaves the focus alone.
    const notice = document.getElementById(inboxItemDomId(id));
    const titles = Array.from(document.querySelectorAll<HTMLElement>('[data-inbox-title]')).filter(
      (title) => !notice?.contains(title),
    );
    const next = titles.find(
      (title) => notice && notice.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const previous = titles.findLast(
      (title) => notice && notice.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_PRECEDING,
    );
    const hadFocus =
      !document.activeElement ||
      document.activeElement === document.body ||
      notice?.contains(document.activeElement);
    setLingering((current) => {
      const nextMap = new Map(current);
      nextMap.delete(id);
      return nextMap;
    });
    // The cards may be built again when the groups go (the heading element is a new one): look it up by its card.
    const targetId = (next ?? previous)?.closest('article')?.id;
    if (hadFocus && targetId)
      window.requestAnimationFrame(() =>
        document.getElementById(targetId)?.querySelector<HTMLElement>('[data-inbox-title]')?.focus(),
      );
  };

  // A card's drawer opens over the page (the nested route) and closes back here (PM-501).
  const drawerBase = useMemo<DrawerBase>(
    () => ({
      close: `/p/${key}/inbox`,
      card: (taskKey, sub) => `/p/${key}/inbox/tasks/${taskKey}${sub ? `/${sub}` : ''}`,
    }),
    [key],
  );
  const openedKey = useMatch('/p/:projectKey/inbox/tasks/:taskKey/*')?.params.taskKey ?? null;
  // The item whose card row opened the drawer: closing it, the focus returns to that row's link.
  const openedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (openedKey) return;
    const itemId = openedFrom.current;
    openedFrom.current = null;
    if (!itemId) return;
    document
      .getElementById(inboxItemDomId(itemId))
      ?.querySelector<HTMLElement>('[data-inbox-card-link]')
      ?.focus();
  }, [openedKey]);
  const rememberOpener = (event: MouseEvent<HTMLElement>) => {
    const link = (event.target as Element).closest('[data-inbox-card-link]');
    const id = link?.closest('article')?.id;
    if (id) openedFrom.current = id.slice(inboxItemDomId('').length);
  };
  // The drawer of a card opened by its address shows before the list does.
  const withDrawer = (page: ReactNode) => (
    <DrawerBaseContext.Provider value={drawerBase}>
      {page}
      <Outlet />
    </DrawerBaseContext.Provider>
  );

  // The card row links to the drawer while the board loads (or failed) and when the card is on it; a card
  // the loaded board does not have is plain text.
  const taskHrefOf = (item: InboxItem): string | null =>
    item.taskKey && (!board.data || titles.has(item.taskKey)) ? drawerBase.card(item.taskKey) : null;

  if (inbox.isPending) return withDrawer(<LoadingState />);
  if (inbox.isError)
    return withDrawer(<ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />);

  const counts = new Map<DisplayKind, number>();
  for (const item of mine) counts.set(displayKindOf(item), (counts.get(displayKindOf(item)) ?? 0) + 1);
  // A pill per kind that has something waiting (and the one picked, so its empty text can say so).
  const pillKinds = FILTER_KINDS.filter((kind) => (counts.get(kind) ?? 0) > 0 || kind === filter);
  const filtered = filter === 'all' ? mine : mine.filter((item) => displayKindOf(item) === filter);
  // Keep an edited integrator card mounted in the render that first observes its external closure.
  const displayedLingering = new Map(lingering);
  for (const item of items ?? []) {
    if (isIntegratorTodo(item) && shownOpen.current.has(item.id) && closedBySomeoneElse(item, myHandle))
      displayedLingering.set(item.id, lingering.get(item.id) ?? 'closed');
  }
  // A question that closed while open keeps its place as a notice, whatever the filter.
  const gone = (items ?? []).filter(
    (item) => lingering.has(item.id) && !isIntegratorTodo(item) && !filtered.some((f) => f.id === item.id),
  );
  const visible = gone.length > 0 ? newestFirst([...filtered, ...gone]) : filtered;
  const todoCount = visible.filter((item) => displayKindOf(item) === 'todo').length;
  const grouped = todoCount > 0 && todoCount < visible.length;
  const latest = mine[0];
  const resolveFailedFor = (item: InboxItem) =>
    resolve.isError && resolve.variables?.item.id === item.id ? resolve.error : null;

  const renderCard = (item: InboxItem) => (
    <InboxCard
      key={item.id}
      item={item}
      members={members}
      myHandle={myHandle}
      pipeline={pipeline}
      labels={board.data?.labels}
      mobile={isMobile}
      taskTitle={item.taskKey ? (titles.get(item.taskKey) ?? null) : null}
      taskHref={taskHrefOf(item)}
      detailsHref={detailsHrefFor(item, key)}
      approvalHint={approvalHintOf(item, {
        task: board.data?.tasks.find((task) => task.key === item.taskKey),
        items: items ?? [],
        myHandle,
      })}
      cardHref={item.taskKey ? `/p/${key}/tasks/${item.taskKey}` : null}
      pending={resolve.isPending && resolve.variables?.item.id === item.id}
      closedWhileOpen={displayedLingering.get(item.id) ?? null}
      onDismissGone={() => dismissGone(item.id)}
      error={
        // A refused "Tovább" says why on its card (the gate), not in a toast.
        item.kind === 'hand_on' && resolve.isError && resolve.variables?.item.id === item.id
          ? moveErrorText(
              resolve.error,
              board.data?.labels ?? [],
              refusalFactsOf({
                task: board.data?.tasks.find((task) => task.key === item.taskKey),
                config,
                members,
                myHandle,
                target: pipeline?.stageById.get(handOnRequestOf(item)?.toStageId ?? '')?.name ?? '',
              }),
            )
          : // A refused release decision (the integrator's key is no approval) says why on its card.
            item.kind === 'release' && resolve.isError && resolve.variables?.item.id === item.id
            ? errorMessage(resolve.error)
            : // A todo's "Nem tudom megcsinálni" without a reason is refused by the server too.
              displayKindOf(item) === 'todo' && resolveFailedFor(item) && !lingering.has(item.id)
              ? errorMessage(resolveFailedFor(item))
              : null
      }
      stale={
        // A stale Operator approval says so on its card, not in a toast.
        (operatorApprovalOf(item) !== null || operatorKnowledgeApprovalOf(item) !== null) &&
        resolve.isError &&
        resolve.variables?.item.id === item.id &&
        isStaleError(resolve.error)
      }
      onResolve={(target, body) =>
        resolve.mutate(
          { item: target, body },
          {
            onSuccess: () => {
              const text =
                operatorApprovalOf(target) !== null || operatorKnowledgeApprovalOf(target) !== null
                  ? operatorDecisionToast(target, body.optionId)
                  : target.kind === 'hand_on'
                    ? handOnToast(target, pipeline)
                    : ((target.askerStart ? askerStartToast(target, members, myHandle) : null) ??
                      decisionToast(target, body.optionId, myHandle));
              if (text) toast.show(text, 'ok');
            },
            onError: (error) => {
              // The question closed under the answer: the card says so, a toast would repeat it.
              if (target.kind === 'question' && isApiError(error) && error.code === 'inbox_item_closed') {
                setLingering((current) => new Map(current).set(target.id, 'refused'));
                return;
              }
              if (
                target.kind !== 'hand_on' &&
                target.kind !== 'release' &&
                displayKindOf(target) !== 'todo' &&
                !isStaleError(error)
              )
                toast.show(t('inbox.resolveFailed'), 'error');
            },
          },
        )
      }
    />
  );

  return withDrawer(
    <div className={styles.page} onClick={rememberOpener}>
      <div className={styles.main}>
        <PageHeader
          className={styles.header}
          hideTitleOnPhone
          title={t('inbox.title')}
          subtitle={
            // On phones an empty inbox says it in the empty state below; no repeat here.
            isMobile && !latest
              ? null
              : isMobile && latest
                ? t('inbox.mobileSubtitle', { count: mine.length, time: formatTime(latest.createdAt) })
                : t('inbox.subtitle')
          }
        />
        {isMobile || mine.length === 0 ? null : (
          <SegmentedControl<KindFilter>
            label={t('inbox.filtersLabel')}
            appearance="pills"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('inbox.filters.all'), count: mine.length },
              ...pillKinds.map((kind) => ({
                value: kind,
                label: t(`inbox.kinds.${kind}`),
                count: counts.get(kind) ?? 0,
              })),
            ]}
          />
        )}
        <div className={styles.list}>
          {grouped ? (
            <>
              <h2 className={styles.groupHeading}>{t('inbox.groups.decisions')}</h2>
              {visible.filter((item) => displayKindOf(item) !== 'todo').map(renderCard)}
              <h2 className={styles.groupHeading}>
                {t('inbox.groups.todo')}
                <span className={styles.groupHint}>{t('inbox.groups.todoHint')}</span>
              </h2>
              {visible.filter((item) => displayKindOf(item) === 'todo').map(renderCard)}
            </>
          ) : (
            visible.map(renderCard)
          )}
          {visible.length === 0 ? (
            <EmptyState
              tone="ok"
              icon="check"
              title={
                filter === 'all'
                  ? t('inbox.allDoneEverywhere')
                  : filter === 'todo'
                    ? t('inbox.todo.emptyFilter')
                    : t('inbox.allDone')
              }
            />
          ) : null}
        </div>
        {isOwner && (filter === 'all' || filter === 'todo') ? (
          <IntegratorTodos
            items={items ?? []}
            lingering={displayedLingering}
            renderCard={renderCard}
            members={members}
            myHandle={myHandle}
          />
        ) : null}
        {isMobile ? (
          <>
            <RecentDecisions
              items={recent.slice(0, 4)}
              automatic={automatic}
              members={members}
              myHandle={myHandle}
              pipeline={pipeline}
              onRevoke={onRevoke}
            />
            {can.manageTeam ? (
              <OperatorTrail projectKey={key} members={members} myHandle={myHandle} taskHrefOf={taskHrefOf} />
            ) : null}
          </>
        ) : null}
      </div>
      {isMobile ? null : (
        <aside className={styles.aside}>
          <RecentDecisions
            items={recent}
            automatic={automatic}
            members={members}
            myHandle={myHandle}
            pipeline={pipeline}
            onRevoke={onRevoke}
          />
          {can.manageTeam ? (
            <OperatorTrail projectKey={key} members={members} myHandle={myHandle} taskHrefOf={taskHrefOf} />
          ) : null}
        </aside>
      )}
    </div>,
  );
}

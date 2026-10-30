import clsx from 'clsx';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  alertPayloadOf,
  canSeeTeamMessage,
  cardWorkerSessions,
  reachingDevelopers,
  fitsSpecialty,
  stageDevelopers,
  workStageOf,
  fixLimitDecisionOf,
  isOnLeave,
  isDeveloper,
  isTheme,
  loopDecisionOf,
} from '@projectman/shared';
import type { Task, TimelineEvent } from '@projectman/shared';
import {
  useBoard,
  useConfig,
  useAttachments,
  useInbox,
  useLabels,
  useResolveInbox,
  useStartTask,
  useTaskDetail,
  useTaskMessages,
} from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button, ButtonLink } from '../../components/Button';
import { SelectField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { leaveSuffix } from '../../components/LeaveChip';
import { SegmentedControl } from '../../components/SegmentedControl';
import { ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { startWaitingHint } from '../../lib/taskState';
import { joinNames, t } from '../../i18n/t';
import { errorMessage, isApprovalRequested, isGateBlocked } from '../../lib/errors';
import { unmetGateTexts } from '../../lib/gates';
import { approvalHintOf, decisionToast, openItemIds, openItemsFor } from '../../lib/inbox';
import { closureTexts, sessionClosure, sessionStatus } from '../../lib/sessions';
import { isTaskClosed } from '../../lib/taskState';
import { isApiError } from '../../api/client';
import { isPageEscape, useDocumentTitle, useIsMobile, useMediaQuery } from '../../lib/hooks';
import { distinctMembers, nameOf } from '../../lib/members';
import { canStartRefinement } from '../../lib/refinement';
import type { MemberIndex } from '../../lib/members';
import { InboxCard } from '../inbox/InboxCard';
import { showInboxItem } from '../inbox/Question';
import { Todo as OutageTodoBox } from '../inbox/OutageAlert';
import { openPrerequisiteKeys, PrerequisiteWarning, refusedPrerequisites } from './PrerequisiteWarning';
import { ComplexityWarning } from './ComplexityWarning';
import { CardSizeProvider, SIZE_PARAM, withCardSize } from './cardSize';
import type { CardSize } from './cardSize';
import { useDrawerBase, withQueryParam } from './drawerBase';
import { nextStepLine } from './NextStep';
import { RefineButton } from './RefineButton';
import { MergeBox } from './MergeBox';
import { SignalBox } from './SignalBox';
import { WhyBox } from './WhyBox';
import { primarySession } from './taskModel';
import { useBoardModel } from './useBoardModel';
import { useCanAttach, useUploadQueue } from './attachmentUploads';
import { useFileDrop } from './useFileDrop';
import { TaskAttachments } from './TaskAttachments';
import { TaskSteps } from './TaskSteps';
import { TaskTimeline } from './TimelineAttachment';
import { TaskCommentComposer } from './TaskCommentComposer';
import { TaskDescription } from './TaskEdit';
import { TaskAcceptance } from './TaskAcceptance';
import { TaskProperties } from './TaskProperties';
import { TaskThread } from './TaskThread';
import { TaskRounds, TaskUsage } from './TaskUsage';
import { TaskMove } from './TaskMove';
import { canMoveTask } from './moveTask';
import drawer from './drawer.module.css';
import styles from './TaskDrawer.module.css';
import { TaskHeader } from './TaskHeader';
import { useHeldStart, useTeamPaused } from '../pause/usePause';
import { ThemeCards, ThemeHeader, ThemeSummary } from './ThemeDrawer';

function StartPanel({
  task,
  members,
  tasks,
  canRefine,
}: {
  task: Task;
  members: MemberIndex;
  tasks: readonly Task[];
  /** Whether the "Kidolgozás" button is shown beside the panel: only then is it pointed at. */
  canRefine: boolean;
}) {
  const { key, can } = useProject();
  const labels = useLabels(key);
  const config = useConfig(key, can.readConfig).data?.config;
  const start = useStartTask(key);
  const toast = useToast();
  // A pause holds the start: the button stays in its place but does nothing, and says why (PM-220).
  // So does switched-off AI work (PM-291); the pause's reason comes first.
  const paused = useTeamPaused();
  const aiOff = useBoard(key).data?.aiEnabled === false;
  const held = useHeldStart(paused || aiOff, paused ? t('pause.disabled.start') : t('task.aiOffStart'));
  const [assignee, setAssignee] = useState('');
  // The open prerequisites the person is warned about before the start goes ahead (PM-204).
  const [warning, setWarning] = useState<string[] | null>(null);
  // Confirm a manual assignment above the limit before asking about prerequisites.
  const [complexityWarning, setComplexityWarning] = useState(false);
  const send = (despitePrerequisites: boolean) =>
    start.mutate(
      {
        taskKey: task.key,
        body: {
          ...(assignee ? { assignee } : {}),
          ...(despitePrerequisites ? { despitePrerequisites } : {}),
        },
      },
      {
        onSuccess: (started) => {
          setWarning(null);
          // The response identifies a card held for a suitable developer.
          if (started.task.startWaiting?.reason === 'senior_busy' && !started.task.assignee)
            toast.show(t('task.startedSeniorWait', { key: task.key }), 'info');
          else toast.show(t('task.started', { key: task.key }));
        },
        onError: (error) => {
          // Not a failure: the approvers were asked, and the task waits for them.
          if (isApprovalRequested(error)) toast.show(t('errors.approvalRequested'), 'info');
          // The card gained a prerequisite the board has not shown yet: the same warning.
          else setWarning(refusedPrerequisites(error));
        },
      },
    );
  const openKeys = openPrerequisiteKeys(task, tasks);
  const developers = distinctMembers(members).filter((member) => {
    const original = config?.team.members.find((entry) => entry.handle === member.handle);
    return (
      member.kind === 'ai' &&
      member.status !== 'retired' &&
      (original && config ? isDeveloper(config, original) : member.complexityLimit !== undefined)
    );
  });
  // The shared stage rule includes busy developers and developers on leave.
  const points = task.complexity?.points;
  const workStage = config && workStageOf(config, task);
  const reaches =
    config && workStage
      ? reachingDevelopers(stageDevelopers(config, workStage), points ?? null, task.labels).length > 0
      : developers.some(
          (member) =>
            fitsSpecialty(member, task.labels) &&
            member.complexityLimit !== undefined &&
            member.complexityLimit >= (points ?? 0),
        );
  const hint = !points
    ? undefined
    : !reaches
      ? t('task.complexity.startNoneReach', { points })
      : t('task.complexity.startHint', { points });
  const chosen = developers.find((member) => member.handle === assignee);
  const goOn = () => (openKeys.length > 0 ? setWarning(openKeys) : send(false));
  return (
    <div className={styles.start}>
      <SelectField
        label={t('task.assigneeLabel')}
        value={assignee}
        hint={hint}
        onChange={(event) => setAssignee(event.target.value)}
      >
        <option value="">{points ? t('task.complexity.auto', { points }) : t('task.assigneeAuto')}</option>
        {developers.map((member) => (
          // The server refuses a start for a member on leave (member_on_leave): not offered as a pick.
          <option key={member.handle} value={member.handle} disabled={isOnLeave(member)}>
            {`${member.displayName} · ${member.handle}`}
            {points && member.complexityLimit !== undefined
              ? ` · ${t('team.limit', { limit: member.complexityLimit })}`
              : ''}
            {isOnLeave(member) ? leaveSuffix(member) : ` · ${t(`memberStatus.${member.status}`)}`}
          </option>
        ))}
      </SelectField>
      {start.isError && !isApprovalRequested(start.error) && !refusedPrerequisites(start.error) ? (
        <p className={drawer.error} role="alert">
          {errorMessage(start.error)}
          {isGateBlocked(start.error) &&
          isApiError(start.error) &&
          unmetGateTexts(start.error.details, labels).length > 0
            ? ` ${t('errors.gateUnmet', { conditions: joinNames(unmetGateTexts(start.error.details, labels)) })}`
            : null}
          {isGateBlocked(start.error) && canRefine ? ` ${t('task.refine.suggestion')}` : null}
        </p>
      ) : null}
      <Button
        variant="primary"
        size="md"
        icon="play"
        loading={start.isPending}
        {...held.buttonProps}
        onClick={() =>
          points && chosen?.complexityLimit !== undefined && chosen.complexityLimit < points
            ? setComplexityWarning(true)
            : goOn()
        }
      >
        {start.isPending ? t('task.starting') : t('task.start')}
      </Button>
      {held.note}
      <ComplexityWarning
        name={complexityWarning && chosen ? chosen.displayName : null}
        points={points ?? 0}
        limit={chosen?.complexityLimit ?? 5}
        onConfirm={() => {
          setComplexityWarning(false);
          goOn();
        }}
        onClose={() => setComplexityWarning(false)}
      />
      <PrerequisiteWarning
        keys={warning}
        tasks={tasks}
        loading={start.isPending}
        onConfirm={() => send(true)}
        onClose={() => setWarning(null)}
      />
    </div>
  );
}

/** The large window has two columns from this width on: its own 1040px (the window is 64px narrower than the screen). */
const WIDE_QUERY = '(min-width: 1104px)';

/** The views of the open card (PM-487): the sub-paths of its route, `card` being none. */
type CardView = 'card' | 'thread' | 'attachments' | 'steps' | 'timeline';

/**
 * The open card (PM-283): the quick view is the drawer on the right of the board, the large window (`?size=large`)
 * floats in the middle of it over a backdrop, and a phone always has the drawer. The same component and the same
 * sections show both: they keep their place in the tree (and so a draft) when the size or the number of columns changes.
 */
export function TaskDrawer() {
  const { taskKey = '', '*': subPath } = useParams();
  const { key, myHandle, can, me } = useProject();
  const [searchParams, setSearchParams] = useSearchParams();
  // A link to one event of the timeline (#timeline-<id>) scrolls the timeline to that row itself.
  const location = useLocation();
  const eventLink = location.hash.startsWith('#timeline-');
  const mobile = useIsMobile();
  const size: CardSize = !mobile && searchParams.get(SIZE_PARAM) === 'large' ? 'large' : 'quick';
  const twoColumns = useMediaQuery(WIDE_QUERY) && size === 'large';
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Replaces the history entry: the browser's Back goes to where the card was opened from.
  const toggleSize = mobile
    ? undefined
    : () => {
        const next = new URLSearchParams(searchParams);
        if (size === 'large') next.delete(SIZE_PARAM);
        else next.set(SIZE_PARAM, 'large');
        setSearchParams(next, { replace: true });
      };
  const access = me.projects.find((project) => project.key === key)?.access;
  const navigate = useNavigate();
  const { board, members, pipeline, model } = useBoardModel();
  const detail = useTaskDetail(key, taskKey);
  const labels = useLabels(key);
  const configQuery = useConfig(key, can.readConfig);
  const config = configQuery.data?.config;
  const inbox = useInbox(key);
  const resolve = useResolveInbox(key, myHandle);
  const toast = useToast();
  // The merge box sends the card back to the developers: the move panel opens at the work stage.
  const [sendBack, setSendBack] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const drawerBase = useDrawerBase();
  const close = () => navigate(drawerBase.close);

  const boardTask = board.data?.tasks.find((task) => task.key === taskKey);
  const task = detail.data?.task ?? boardTask;
  const entry = model?.byKey.get(taskKey);
  // The card's conversation (PM-273): a view of the same open card (`/thread`), not a page. A theme has none.
  const hasThread = Boolean(task && !isTheme(task) && entry);
  // The views of the open card (PM-487) are sub-paths of it; an unknown one, and a theme's `/thread`, is the card.
  // An older link to one event (`/tasks/KEY#timeline-<id>`, shared before the timeline had a view) opens the timeline.
  // The Process view (PM-1151) is a card's, like the conversation: a theme has none.
  const view: CardView =
    subPath === 'attachments' || subPath === 'timeline'
      ? subPath
      : (subPath === 'thread' || subPath === 'steps') && hasThread
        ? subPath
        : !subPath && eventLink
          ? 'timeline'
          : 'card';
  const thread = view === 'thread';
  const taskMessages = useTaskMessages(key, taskKey, hasThread);
  const messageCount = taskMessages.data?.messages.length ?? 0;
  // The same query (and so the same request) as the list of the Attachments view.
  const attachmentList = useAttachments(key, taskKey, Boolean(access && myHandle));
  const attachmentCount = attachmentList.data?.attachments.length ?? 0;
  // The Process tab counts the open steps; none, or not read, shows no count.
  const stepCount = detail.data?.steps?.length ?? 0;
  const cardScroll = useRef(0);
  const viewsRef = useRef<HTMLDivElement>(null);
  const switchView = (next: CardView) =>
    navigate(withCardSize(drawerBase.card(taskKey, next === 'card' ? undefined : next), size), {
      replace: true,
    });
  // Files dropped or pasted show the Attachments view, so the upload and its failure are in sight.
  const showAttachments = () => {
    if (view !== 'attachments') switchView('attachments');
  };
  // The whole open card takes files: they join the same queue as the files chosen in its list.
  const uploads = useUploadQueue();
  const canAttach = useCanAttach();
  const fileDrop = useFileDrop({
    allowed: task ? canAttach : false,
    onFiles: (files) => {
      if (!task) return;
      uploads.add(task.key, files);
      showAttachments();
    },
    isolate: true,
  });
  useDocumentTitle(task ? `${task.key} ${task.title}` : taskKey, board.data?.project.name);

  useEffect(() => {
    headingRef.current?.focus();
  }, [taskKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A dialog, a popover or a field takes Escape for itself: a draft in the card is not discarded by it.
      if (isPageEscape(event)) navigate(drawerBase.close);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerBase.close, navigate]);

  // The large window holds the focus and the pointer: all that lies under it (the menu, the bars, the board)
  // is inert, so Tab stays inside it. Not a modal <dialog>: that would cover the toasts and the popovers.
  useEffect(() => {
    const panel = panelRef.current;
    if (size !== 'large' || !panel) return;
    const inerted: Element[] = [];
    for (let node: Element | null = panel; node && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement?.children ?? []) {
        if (sibling === node || sibling.hasAttribute('inert') || sibling.hasAttribute('data-inert-exempt'))
          continue;
        sibling.setAttribute('inert', '');
        inerted.push(sibling);
      }
    }
    return () => inerted.forEach((element) => element.removeAttribute('inert'));
  }, [size]);

  // A window opens at the start of the card. The Thread view keeps its own place instead (its end, or the
  // message a link led to), and the card is at the start when it is shown again.
  useEffect(() => {
    cardScroll.current = 0;
    if (scrollRef.current && (view === 'card' || view === 'attachments')) scrollRef.current.scrollTop = 0;
  }, [size]);

  // Hiding the card's sections shortens the scroll box and so moves it: the card is put back where it was, the
  // attachments open at their start, and the timeline at its end (the latest event, the next step, the comment box).
  const timelineEnd = view === 'timeline' && !detail.isPending && !eventLink;
  const timelineStick = useRef(true);
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box || thread) return;
    if (view === 'timeline' && eventLink) return;
    if (timelineEnd) timelineStick.current = true;
    box.scrollTop =
      view === 'card' ? cardScroll.current : view === 'attachments' ? 0 : timelineEnd ? box.scrollHeight : 0;
  }, [view, thread, timelineEnd, eventLink]);

  // The timeline stays at its end while its content still grows (the comment box, the next step, a resize of the
  // window), until the reader scrolls away from the end.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || !timelineEnd || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (timelineStick.current) box.scrollTop = box.scrollHeight;
    });
    observer.observe(box);
    for (const child of Array.from(box.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [timelineEnd, twoColumns]);

  // On a narrow phone the row of views scrolls: the open view stays in it.
  useEffect(() => {
    viewsRef.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [view]);

  const openIds = useMemo(() => openItemIds(inbox.data?.items), [inbox.data]);
  // The "Miért áll?" box carries the button of the viewer's hand-on item (PM-461): no card of it as well.
  const handOnId = entry?.state.next?.you ? entry.state.wait?.inboxItemId : null;
  useEffect(() => {
    const id = location.hash.slice(1);
    const target = id ? document.getElementById(id) : null;
    if (target) showInboxItem(target);
  }, [location.hash, inbox.data, taskKey]);
  const myItems = openItemsFor(inbox.data?.items, myHandle, true).filter(
    (item) => item.taskKey === taskKey && !(item.kind === 'hand_on' && item.id === handOnId),
  );

  // A merge's inbox item stands in place of the box only while the merge is requested; once it failed or
  // stopped, the box carries the steps and the buttons, and the item stays on the "Rád vár" page (PM-453).
  const isMergeItem = (item: (typeof myItems)[number]) =>
    item.kind === 'merge_request' || alertPayloadOf(item)?.alert === 'merge_blocked';
  const mergeState = task?.merge?.state;
  const shownItems =
    mergeState && mergeState !== 'requested' ? myItems.filter((item) => !isMergeItem(item)) : myItems;

  const body = (() => {
    // Until there is a head, the close button stands alone above the state: behind the large window
    // the board cannot be reached, so Escape must not be the only way out.
    const closeOnly = (state: ReactNode) => (
      <>
        <div className={styles.bar}>
          <Button variant="muted" iconOnly icon="close" onClick={close} aria-label={t('common.close')} />
        </div>
        <div className={styles.center}>{state}</div>
      </>
    );
    if (!task) {
      if (detail.isPending || board.isPending) return closeOnly(<LoadingState />);
      // A card that does not exist is no failure to retry: it has its own text.
      if (detail.isError && !(isApiError(detail.error) && detail.error.status === 404))
        return closeOnly(<ErrorState error={detail.error} onRetry={() => void detail.refetch()} />);
      return closeOnly(<p className={styles.missing}>{t('task.notFound', { key: taskKey })}</p>);
    }
    if (!pipeline) return closeOnly(<LoadingState />);
    // A theme is no card of the pipeline: it has its own head, progress and cards, and nothing to start or move.
    const theme = isTheme(task);
    if (!theme && !entry) return closeOnly(<LoadingState />);
    const stage = pipeline.stageById.get(task.stageId);
    const parent =
      board.data?.tasks.find((candidate) => candidate.key === task.parentKey) ?? detail.data?.parent;
    // The relations are counted from the board's cards (the closed ones too): no request of their own.
    const cards = board.data?.tasks ?? [...(detail.data?.subtasks ?? []), ...(parent ? [parent] : [])];
    const phases = new Map([...(model?.byKey ?? [])].map(([cardKey, { state }]) => [cardKey, state.phase]));
    const sessions = detail.data?.sessions ?? [];
    // The first named worker's session, which is where the command they run can be seen.
    const firstWorker = entry?.state.workers[0];
    const session =
      sessions.find((candidate) => candidate.id === firstWorker?.sessionId) ?? primarySession(task, sessions);
    // A card in the work stage that waits for its prerequisites can be started by a person too (PM-204).
    const isQueued =
      !theme &&
      !isTaskClosed(task) &&
      !task.assignee &&
      (stage?.kind === 'queue' || task.startWaiting?.reason === 'prerequisite_open');
    // A person who may put the `refine` label on a card that is not being refined can start it with a button.
    const canRefine =
      !theme && can.createTasks && config && myHandle ? canStartRefinement(task, config, myHandle) : false;
    const workers = cardWorkerSessions(
      stage ? { kind: stage.kind, owners: stage.owners ?? [] } : undefined,
      task,
      sessions,
    ).map((worker) => worker.member);
    // Where a link into the card's conversation leads: the same size as the open card.
    const threadHref = hasThread ? withCardSize(drawerBase.card(task.key, 'thread'), size) : null;
    // A timeline row of a message links to it in the conversation, if the viewer may read that message.
    const fullMessageHref = (event: TimelineEvent): string | null => {
      if (!hasThread || event.type !== 'team_message' || !access || !myHandle) return null;
      const { messageId, to } = event.data;
      // A message of the system (a relation notice, PM-421) has no member as its actor: the event names the sender.
      const from = typeof event.data.from === 'string' ? event.data.from : event.actor.handle;
      if (!from || typeof messageId !== 'string' || !Array.isArray(to)) return null;
      const recipients = to.filter((handle): handle is string => typeof handle === 'string');
      if (!canSeeTeamMessage({ access, handle: myHandle }, { from, to: recipients })) return null;
      return withCardSize(withQueryParam(drawerBase.card(task.key, 'thread'), 'message', messageId), size);
    };
    // The Start is offered only when the shared rule lets a person start the card (PM-291); what it waits for
    // is on the status line. While the rule's data loads a bar holds its place; if it never comes, the
    // Start shows as before and the server decides.
    const startBlock = entry?.state.startBlock;
    const startLoading = can.readConfig && configQuery.isPending;
    const startOffered = isQueued && can.createTasks && !startBlock;
    const refineFirst = canRefine && startBlock?.kind === 'unmet' && startBlock.refines;
    const hasActions =
      startOffered ||
      canRefine ||
      Boolean(session && can.workInSessions) ||
      canMoveTask(task, can.createTasks);
    // The sections come in four groups, in the order of the quick view. The large window with two columns
    // reads the left one first and the right one (`side`) last, and moves the groups, not the sections:
    // a group keeps its place under the scroll box, so what is typed in it is not lost.
    const signals = (
      <div key="signals" className={styles.group} hidden={view !== 'card'}>
        {entry && !theme ? (
          <WhyBox
            task={task}
            state={entry.state}
            pipeline={pipeline}
            members={members}
            labels={labels}
            inboxItems={inbox.data?.items}
            config={config}
          />
        ) : null}
        <SignalBox
          task={task}
          members={members}
          myHandle={myHandle}
          messagesHref={threadHref}
          sessions={sessions}
          decidingLoop={myItems.some((item) => loopDecisionOf(item))}
          decidingFixLimit={myItems.some((item) => fixLimitDecisionOf(item))}
        />
        <MergeBox
          task={task}
          members={members}
          myHandle={myHandle}
          config={config}
          asked={myItems.some(isMergeItem)}
          onSendBack={() => setSendBack((count) => count + 1)}
        />
        {shownItems.length > 0 ? (
          <section className={drawer.section}>
            {shownItems.map((item) => (
              <InboxCard
                key={item.id}
                item={item}
                members={members}
                myHandle={myHandle}
                pipeline={pipeline}
                labels={labels}
                compact
                headingLevel={3}
                pending={resolve.isPending && resolve.variables?.item.id === item.id}
                onResolve={(target, request) =>
                  resolve.mutate(
                    { item: target, body: request },
                    {
                      onSuccess: () => toast.show(decisionToast(target, request.optionId, myHandle), 'ok'),
                      onError: () => toast.show(t('inbox.resolveFailed'), 'error'),
                    },
                  )
                }
                detailsHref={item.sessionId ? `/p/${key}/sessions/${item.sessionId}` : null}
                approvalHint={approvalHintOf(item, { task, items: inbox.data?.items ?? [], myHandle })}
              />
            ))}
          </section>
        ) : null}
      </div>
    );
    const boxShown = !!entry && !theme && !!entry.state.next;
    const loginCommand =
      task.startWaiting?.reason === 'provider_not_logged_in' && task.startWaiting.provider !== 'nanogpt'
        ? t(`providerSettings.loginCommands.${task.startWaiting.provider ?? 'claude'}`)
        : null;
    const side = (
      <div key="side" className={clsx(styles.group, styles.side)} hidden={view !== 'card' && !twoColumns}>
        {task.outage ? (
          // The card stands on an outage (PM-468), a start or a continuation: the header says why, this what to do.
          // The state has no `next` then, so the "Miért áll?" box is not shown beside it.
          <div className={drawer.section} data-testid="drawer-outage">
            <OutageTodoBox outage={task.outage} projectKey={key} />
          </div>
        ) : task.startWaiting && (!boxShown || loginCommand) ? (
          <p className={drawer.section}>
            {/* The "Miért áll?" box already says the hint as its "Mit kell tenni" row. */}
            {boxShown ? null : startWaitingHint(task, members, myHandle)}
            {loginCommand ? (
              <>
                {boxShown ? null : ' '}
                <code>{loginCommand}</code>
              </>
            ) : null}
          </p>
        ) : null}
        <div className={styles.actions} hidden={!hasActions}>
          {canRefine ? <RefineButton task={task} primary={refineFirst} /> : null}
          {startOffered && startLoading ? (
            <div className={styles.startLoading} role="status">
              <span className="visually-hidden">{t('task.startLoading')}</span>
            </div>
          ) : startOffered ? (
            <StartPanel task={task} members={members} tasks={board.data?.tasks ?? []} canRefine={canRefine} />
          ) : isQueued && can.createTasks ? null : session && can.workInSessions ? (
            <>
              <ButtonLink
                to={`/p/${key}/sessions/${session.id}`}
                variant="primary"
                size="md"
                iconRight="arrowRight"
                className={styles.grow}
              >
                {t('task.openSession')}
              </ButtonLink>
              <ButtonLink to={`/p/${key}/sessions/${session.id}?compose=1`} variant="secondary" size="md">
                {t('task.message')}
              </ButtonLink>
            </>
          ) : null}
          {canMoveTask(task, can.createTasks) ? (
            <TaskMove
              key={`${task.key}:${task.stageId}`}
              task={task}
              pipeline={pipeline}
              tasks={board.data?.tasks ?? []}
              config={config}
              sendBack={sendBack}
            />
          ) : null}
        </div>

        {theme ? (
          <ThemeSummary task={task} tasks={cards} />
        ) : (
          <TaskProperties
            task={task}
            tasks={cards}
            phases={phases}
            members={members}
            pipeline={pipeline}
            sessions={sessions}
          />
        )}
      </div>
    );
    const content = (
      <div key="content" className={styles.group} hidden={view !== 'card'}>
        <TaskDescription key={`description:${task.key}`} task={task} className={styles.description} />

        {theme ? null : (
          <TaskAcceptance
            key={`acceptance:${task.key}`}
            task={task}
            items={detail.data?.acceptance}
            loading={detail.isPending}
          />
        )}

        {theme && model ? (
          <ThemeCards task={task} tasks={cards} pipeline={pipeline} byKey={model.byKey} />
        ) : null}
      </div>
    );
    const attachments = (
      <div key="attachments" className={styles.group} hidden={view !== 'attachments'}>
        <TaskAttachments
          key={`attachments:${task.key}`}
          task={task}
          members={members}
          onPasted={showAttachments}
        />
      </div>
    );
    // Only the open view is in the tree: it has no draft to keep, and its rows would repeat the card's texts.
    const stepsView = hasThread ? (
      <div key="steps" className={styles.group} hidden={view !== 'steps'}>
        {view === 'steps' ? (
          <section className={drawer.section}>
            {/* The tab names the view: the title stays for the screen readers. */}
            <h2 className={clsx(drawer.sectionTitle, 'visually-hidden')}>{t('task.steps.title')}</h2>
            {detail.isPending ? (
              <LoadingState compact />
            ) : detail.isError ? (
              <ErrorState
                compact
                error={detail.error}
                message={t('task.steps.loadFailed')}
                onRetry={() => void detail.refetch()}
              />
            ) : (
              <TaskSteps
                key={task.key}
                task={task}
                state={entry?.state}
                steps={detail.data.steps}
                events={detail.data.timeline}
                ctx={{ pipeline, members, labels, myHandle, openInboxIds: openIds }}
              />
            )}
          </section>
        ) : null}
      </div>
    ) : null;
    const timeline = (
      <div key="timeline" className={styles.group} hidden={view !== 'timeline'}>
        <section className={drawer.section}>
          {/* The tab names the section: the title stays for the screen readers. */}
          <h3 className={clsx(drawer.sectionTitle, 'visually-hidden')}>{t('task.timeline')}</h3>
          {detail.isPending ? (
            <LoadingState compact />
          ) : detail.isError ? (
            <ErrorState compact error={detail.error} onRetry={() => void detail.refetch()} />
          ) : (
            <TaskTimeline
              task={task}
              events={detail.data.timeline}
              ctx={{ pipeline, members, labels, myHandle, openInboxIds: openIds }}
              fullMessageHref={fullMessageHref}
              next={theme ? null : nextStepLine(task, pipeline, members, myHandle)}
            />
          )}
        </section>

        {can.comment && myHandle ? (
          <TaskCommentComposer key={`comments:${task.key}`} taskKey={task.key} members={members} />
        ) : null}
      </div>
    );
    const more = (
      <div key="more" className={styles.group} hidden={view !== 'card'}>
        {sessions.length > 0 ? (
          <section className={drawer.section}>
            <h3 className={drawer.sectionTitle}>{t('task.sessions')}</h3>
            <ul className={styles.sessions}>
              {[...sessions]
                .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
                .map((entrySession) => {
                  const member = members.get(entrySession.member);
                  const status = sessionStatus(entrySession, entrySession.state === 'waiting_permission');
                  const closure = sessionClosure(entrySession);
                  return (
                    <li key={entrySession.id}>
                      <Link to={`/p/${key}/sessions/${entrySession.id}`} className={styles.sessionRow}>
                        <Avatar member={member} handle={entrySession.member} size="md" status={status} />
                        <span className={styles.sessionText}>
                          <span className={styles.sessionName}>
                            {nameOf(entrySession.member, members, myHandle)}
                          </span>
                          <span
                            className={clsx(styles.sessionState, closure && styles.sessionClosed)}
                            data-status={status}
                          >
                            {closure
                              ? closureTexts(closure, { pipeline, members, myHandle }).list
                              : t(`sessionState.${entrySession.state}`)}
                          </span>
                        </span>
                        <Icon name="chevronRight" size={16} />
                      </Link>
                    </li>
                  );
                })}
            </ul>
          </section>
        ) : null}

        <TaskUsage sessions={sessions} members={members} myHandle={myHandle} />
        <TaskRounds rounds={detail.data?.rounds} fixRounds={detail.data?.fixRounds} sessions={sessions} />
      </div>
    );
    return (
      <>
        {theme || !entry ? (
          <ThemeHeader
            task={task}
            headingRef={headingRef}
            size={size}
            onToggleSize={toggleSize}
            onClose={close}
            rule={false}
          />
        ) : (
          <TaskHeader
            task={task}
            parent={parent}
            state={entry.state}
            pipeline={pipeline}
            members={members}
            labels={labels}
            headingRef={headingRef}
            size={size}
            onToggleSize={toggleSize}
            onClose={close}
            rule={false}
          />
        )}

        <div ref={viewsRef} className={styles.views}>
          <SegmentedControl
            className={styles.switch}
            size="sm"
            label={t('task.view.label')}
            value={view}
            onChange={switchView}
            options={[
              { value: 'card', label: t('task.view.card') },
              // A theme has no conversation. A count is shown only when there is something to count.
              ...(hasThread
                ? [
                    {
                      value: 'thread' as const,
                      label: t('task.view.thread'),
                      count: messageCount > 0 ? messageCount : undefined,
                    },
                  ]
                : []),
              {
                value: 'attachments',
                label: t('task.view.attachments'),
                count: attachmentCount > 0 ? attachmentCount : undefined,
              },
              ...(hasThread
                ? [
                    {
                      value: 'steps' as const,
                      label: t('task.view.steps'),
                      count: stepCount > 0 ? stepCount : undefined,
                    },
                  ]
                : []),
              { value: 'timeline', label: t('task.view.timeline') },
            ]}
          />
        </div>

        <div
          ref={scrollRef}
          className={clsx(styles.scroll, thread && styles.conversation)}
          onScroll={(event) => {
            const box = event.currentTarget;
            if (view === 'card') cardScroll.current = box.scrollTop;
            if (view === 'timeline') {
              timelineStick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
            }
          }}
        >
          {/* All views stay in the tree: what is typed in a hidden one (a message, a comment, a description) is kept. */}
          {[
            ...(twoColumns
              ? [signals, content, attachments, stepsView, timeline, more, side]
              : [signals, side, content, attachments, stepsView, timeline, more]),
            hasThread ? (
              <div key="thread" className={styles.thread} hidden={!thread}>
                <TaskThread
                  key={task.key}
                  task={task}
                  active={thread}
                  query={taskMessages}
                  workers={workers}
                  stageOwners={stage?.owners ?? []}
                  members={members}
                  labels={labels}
                  messageParam={searchParams.get('message')}
                  onShowCard={() => switchView('card')}
                />
              </div>
            ) : null,
          ]}
        </div>
      </>
    );
  })();

  const large = size === 'large';
  return (
    <CardSizeProvider value={size}>
      {large ? <div className={styles.backdrop} data-inert-exempt onClick={close} /> : null}
      {/* One element for both sizes, so the sections below keep their place; only its role tells them apart. */}
      <div
        ref={panelRef}
        className={clsx(styles.drawer, large && styles.window, twoColumns && styles.wide)}
        role={large ? 'dialog' : 'complementary'}
        aria-modal={large ? true : undefined}
        aria-label={t(task && isTheme(task) ? 'theme.drawerLabel' : 'task.drawerLabel')}
        {...fileDrop.props}
      >
        {body}
        {fileDrop.state && task ? (
          <div className={styles.dropOverlay} data-state={fileDrop.state} role="status">
            <Icon name="paperclip" size={28} />
            <b>{t(fileDrop.state === 'over' ? 'attachments.dropActive' : 'attachments.dropDenied')}</b>
            <span>{task.title}</span>
          </div>
        ) : null}
      </div>
    </CardSizeProvider>
  );
}

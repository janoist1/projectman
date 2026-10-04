import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  canSeeAllTeamMessages,
  fixLimitDecisionOf,
  isOnLeave,
  isTheme,
  loopDecisionOf,
} from '@projectman/shared';
import type { Task } from '@projectman/shared';
import {
  useConfig,
  useInbox,
  useLabels,
  useResolveInbox,
  useStartTask,
  useTaskDetail,
} from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button, ButtonLink } from '../../components/Button';
import { SelectField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { leaveSuffix } from '../../components/LeaveChip';
import { ErrorState, LoadingState } from '../../components/States';
import { Timeline } from '../../components/Timeline';
import { useToast } from '../../components/toastContext';
import { startWaitingHint } from '../../lib/taskState';
import { joinNames, t } from '../../i18n/t';
import { errorMessage, isApprovalRequested, isGateBlocked } from '../../lib/errors';
import { unmetGateTexts } from '../../lib/gates';
import { decisionToast, openItemIds, openItemsFor } from '../../lib/inbox';
import { sessionStatus } from '../../lib/sessions';
import { isTaskClosed } from '../../lib/taskState';
import { isApiError } from '../../api/client';
import { useDocumentTitle, useIsMobile, useMediaQuery } from '../../lib/hooks';
import { nameOf } from '../../lib/members';
import { canStartRefinement } from '../../lib/refinement';
import { isDeveloperRole } from '../../lib/roles';
import type { MemberIndex } from '../../lib/members';
import { InboxCard } from '../inbox/InboxCard';
import { openPrerequisiteKeys, PrerequisiteWarning, refusedPrerequisites } from './PrerequisiteWarning';
import { CardSizeProvider, SIZE_PARAM } from './cardSize';
import type { CardSize } from './cardSize';
import { nextStepLine } from './NextStep';
import { RefineButton } from './RefineButton';
import { SignalBox } from './SignalBox';
import { primarySession } from './taskModel';
import { useBoardModel } from './useBoardModel';
import { useCanAttach, useUploadQueue } from './attachmentUploads';
import { useFileDrop } from './useFileDrop';
import { TaskAttachments } from './TaskAttachments';
import { TaskCommentComposer } from './TaskCommentComposer';
import { TaskDescription } from './TaskEdit';
import { TaskProperties } from './TaskProperties';
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
  const { key } = useProject();
  const labels = useLabels(key);
  const start = useStartTask(key);
  const toast = useToast();
  // A pause holds the start: the button stays in its place but does nothing, and says why (PM-220).
  const held = useHeldStart(useTeamPaused(), t('pause.disabled.start'));
  const [assignee, setAssignee] = useState('');
  // The open prerequisites the person is warned about before the start goes ahead (PM-204).
  const [warning, setWarning] = useState<string[] | null>(null);
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
        onSuccess: () => {
          setWarning(null);
          toast.show(t('task.started', { key: task.key }));
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
  const developers = [...members.values()].filter(
    (member) => member.kind === 'ai' && isDeveloperRole(member.role) && member.status !== 'retired',
  );
  return (
    <div className={styles.start}>
      <SelectField
        label={t('task.assigneeLabel')}
        value={assignee}
        onChange={(event) => setAssignee(event.target.value)}
      >
        <option value="">{t('task.assigneeAuto')}</option>
        {developers.map((member) => (
          // The server refuses a start for a member on leave (member_on_leave): not offered as a pick.
          <option key={member.handle} value={member.handle} disabled={isOnLeave(member)}>
            {`${member.displayName} · ${member.handle}`}
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
        onClick={() => (openKeys.length > 0 ? setWarning(openKeys) : send(false))}
      >
        {start.isPending ? t('task.starting') : t('task.start')}
      </Button>
      {held.note}
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

/**
 * The open card (PM-283): the quick view is the drawer on the right of the board, the large window (`?size=large`)
 * floats in the middle of it over a backdrop, and a phone always has the drawer. The same component and the same
 * sections show both: they keep their place in the tree (and so a draft) when the size or the number of columns changes.
 */
export function TaskDrawer() {
  const { taskKey = '' } = useParams();
  const { key, myHandle, can, me } = useProject();
  const [searchParams, setSearchParams] = useSearchParams();
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
  const seesAllMessages = access ? canSeeAllTeamMessages({ access }) : false;
  const navigate = useNavigate();
  const { board, members, pipeline, model } = useBoardModel();
  const detail = useTaskDetail(key, taskKey);
  const labels = useLabels(key);
  const config = useConfig(key, can.createTasks).data?.config;
  const inbox = useInbox(key);
  const resolve = useResolveInbox(key, myHandle);
  const toast = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const close = () => navigate(`/p/${key}`);

  const boardTask = board.data?.tasks.find((task) => task.key === taskKey);
  const task = detail.data?.task ?? boardTask;
  const entry = model?.byKey.get(taskKey);
  // The whole open card takes files: they join the same queue as the files chosen in its list.
  const uploads = useUploadQueue();
  const canAttach = useCanAttach();
  const fileDrop = useFileDrop({
    allowed: task ? canAttach(task) : false,
    onFiles: (files) => task && uploads.add(task.key, files),
    isolate: true,
  });
  useDocumentTitle(task ? `${task.key} ${task.title}` : taskKey, board.data?.project.name);

  useEffect(() => {
    headingRef.current?.focus();
  }, [taskKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // An open dialog or popover takes Escape for itself.
      if (event.key === 'Escape' && !document.querySelector('dialog[open], [data-popover-open]'))
        navigate(`/p/${key}`);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [key, navigate]);

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

  // A window opens at the start of the content.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [size]);

  const openIds = useMemo(() => openItemIds(inbox.data?.items), [inbox.data]);
  const myItems = openItemsFor(inbox.data?.items, myHandle).filter((item) => item.taskKey === taskKey);

  const body = (() => {
    // Until there is a head, the close button stands alone above the state: behind the large window
    // the board cannot be reached, so Escape must not be the only way out.
    const closeOnly = (state: ReactNode) => (
      <>
        <div className={styles.bar}>
          <Button variant="muted" iconOnly icon="close" onClick={close} aria-label={t('common.close')} />
        </div>
        {state}
      </>
    );
    if (!task) {
      if (detail.isPending || board.isPending) return closeOnly(<LoadingState />);
      if (detail.isError)
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
    const hasActions =
      (isQueued && can.createTasks) ||
      canRefine ||
      Boolean(session && can.workInSessions) ||
      canMoveTask(task, can.createTasks);
    // The sections come in four groups, in the order of the quick view. The large window with two columns
    // reads the left one first and the right one (`side`) last, and moves the groups, not the sections:
    // a group keeps its place under the scroll box, so what is typed in it is not lost.
    const signals = (
      <div key="signals" className={styles.group}>
        <SignalBox
          task={task}
          members={members}
          myHandle={myHandle}
          messagesHref={seesAllMessages ? `/p/${key}/messages/all?task=${task.key}` : null}
          decidingLoop={myItems.some((item) => loopDecisionOf(item))}
          decidingFixLimit={myItems.some((item) => fixLimitDecisionOf(item))}
        />
        {myItems.length > 0 ? (
          <section className={drawer.section}>
            {myItems.map((item) => (
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
              />
            ))}
          </section>
        ) : null}
      </div>
    );
    const side = (
      <div key="side" className={clsx(styles.group, styles.side)}>
        {task.startWaiting ? <p className={drawer.section}>{startWaitingHint(task)}</p> : null}
        <div className={styles.actions} hidden={!hasActions}>
          {canRefine ? <RefineButton task={task} /> : null}
          {isQueued && can.createTasks ? (
            <StartPanel task={task} members={members} tasks={board.data?.tasks ?? []} canRefine={canRefine} />
          ) : session && can.workInSessions ? (
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
            />
          ) : null}
        </div>

        {theme ? (
          <>
            <ThemeSummary task={task} tasks={cards} />
            <section className={drawer.props}>
              <div className={drawer.prop}>
                <span className={drawer.propLabel}>{t('newTask.fields.visibility')}</span>
                <span>{t(`visibility.${task.visibility}`)}</span>
              </div>
            </section>
          </>
        ) : (
          <TaskProperties task={task} tasks={cards} phases={phases} members={members} pipeline={pipeline} />
        )}
      </div>
    );
    const content = (
      <div key="content" className={styles.group}>
        <TaskDescription key={`description:${task.key}`} task={task} className={styles.description} />

        {theme && model ? (
          <ThemeCards task={task} tasks={cards} pipeline={pipeline} byKey={model.byKey} />
        ) : null}

        <TaskAttachments key={`attachments:${task.key}`} task={task} members={members} />

        <section className={drawer.section}>
          <h3 className={drawer.sectionTitle}>{t('task.timeline')}</h3>
          {detail.isPending ? (
            <LoadingState compact />
          ) : detail.isError ? (
            <ErrorState compact error={detail.error} onRetry={() => void detail.refetch()} />
          ) : (
            <Timeline
              events={detail.data.timeline}
              ctx={{ pipeline, members, labels, myHandle, openInboxIds: openIds }}
              next={theme ? null : nextStepLine(task, pipeline, members, myHandle)}
            />
          )}
        </section>

        {can.createTasks && myHandle ? (
          <TaskCommentComposer key={`comments:${task.key}`} taskKey={task.key} members={members} />
        ) : null}
      </div>
    );
    const more = (
      <div key="more" className={styles.group}>
        {sessions.length > 0 ? (
          <section className={drawer.section}>
            <h3 className={drawer.sectionTitle}>{t('task.sessions')}</h3>
            <ul className={styles.sessions}>
              {[...sessions]
                .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
                .map((entrySession) => {
                  const member = members.get(entrySession.member);
                  const status = sessionStatus(entrySession, entrySession.state === 'waiting_permission');
                  return (
                    <li key={entrySession.id}>
                      <Link to={`/p/${key}/sessions/${entrySession.id}`} className={styles.sessionRow}>
                        <Avatar member={member} handle={entrySession.member} size="md" status={status} />
                        <span className={styles.sessionText}>
                          <span className={styles.sessionName}>
                            {nameOf(entrySession.member, members, myHandle)}
                          </span>
                          <span className={styles.sessionState} data-status={status}>
                            {t(`sessionState.${entrySession.state}`)}
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
          />
        ) : (
          <TaskHeader
            task={task}
            parent={parent}
            state={entry.state}
            pipeline={pipeline}
            headingRef={headingRef}
            size={size}
            onToggleSize={toggleSize}
            onClose={close}
          />
        )}

        <div ref={scrollRef} className={styles.scroll}>
          {twoColumns ? [signals, content, more, side] : [signals, side, content, more]}
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

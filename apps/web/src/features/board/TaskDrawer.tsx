import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Session, Task } from '@projectman/shared';
import { useInbox, useResolveInbox, useStartTask, useTaskDetail } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button, ButtonLink } from '../../components/Button';
import { Chip, StatusDot } from '../../components/Chip';
import { SelectField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { StageProgress } from '../../components/StageProgress';
import { ErrorState, LoadingState } from '../../components/States';
import { Timeline } from '../../components/Timeline';
import { useToast } from '../../components/Toast';
import { formatAgo } from '../../i18n/format';
import { joinNames, t } from '../../i18n/t';
import { errorMessage, isApprovalRequested, isGateBlocked } from '../../lib/errors';
import { unmetGateTexts } from '../../lib/gates';
import { isApiError } from '../../api/client';
import { useDocumentTitle } from '../../lib/hooks';
import { nameOf, namesOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { nextStage, stagePosition } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import { InboxCard } from '../inbox/InboxCard';
import { prChip } from './cardModel';
import { useBoardModel } from './useBoardModel';
import styles from './TaskDrawer.module.css';

/** The session to open for a task: the assignee's latest, otherwise the latest one. */
export function primarySession(task: Task, sessions: readonly Session[]): Session | null {
  const sorted = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return sorted.find((session) => session.member === task.assignee) ?? sorted[0] ?? null;
}

export function nextStepText(task: Task, pipeline: PipelineIndex, members: MemberIndex, myHandle: string | null): string | null {
  if (task.status === 'done' || task.status === 'cancelled') return null;
  const next = nextStage(pipeline, task.stageId);
  if (!next) return t('task.lastStage');
  if (next.owners.length === 0) return t('task.nextStageNoOwner', { stage: next.name });
  return t('task.nextStage', { stage: next.name, owners: joinNames(namesOf(next.owners, members, myHandle)) });
}

function StartPanel({ task, members }: { task: Task; members: MemberIndex }) {
  const { key, myHandle } = useProject();
  const start = useStartTask(key);
  const toast = useToast();
  const [assignee, setAssignee] = useState('');
  const developers = [...members.values()].filter((member) => member.kind === 'ai' && member.role === 'developer' && member.status !== 'retired');
  return (
    <div className={styles.start}>
      <SelectField label={t('task.assigneeLabel')} value={assignee} onChange={(event) => setAssignee(event.target.value)}>
        <option value="">{t('task.assigneeAuto')}</option>
        {developers.map((member) => (
          <option key={member.handle} value={member.handle}>
            {`${member.displayName} · ${member.handle} · ${t(`memberStatus.${member.status}`)}`}
          </option>
        ))}
      </SelectField>
      {start.isError && !isApprovalRequested(start.error) ? (
        <p className={styles.error} role="alert">
          {errorMessage(start.error)}
          {isGateBlocked(start.error) && isApiError(start.error) && unmetGateTexts(start.error.details, members, myHandle).length > 0
            ? ` ${t('errors.gateUnmet', { conditions: joinNames(unmetGateTexts(start.error.details, members, myHandle)) })}`
            : null}
        </p>
      ) : null}
      <Button
        variant="primary"
        size="xl"
        icon="play"
        fullWidth
        loading={start.isPending}
        onClick={() =>
          start.mutate(
            { taskKey: task.key, body: assignee ? { assignee } : {} },
            {
              onSuccess: () => toast.show(t('task.started', { key: task.key })),
              // Not a failure: the approvers were asked, and the task waits for them.
              onError: (error) => {
                if (isApprovalRequested(error)) toast.show(t('errors.approvalRequested'), 'info');
              },
            },
          )
        }
      >
        {start.isPending ? t('task.starting') : t('task.start')}
      </Button>
    </div>
  );
}

export function TaskDrawer() {
  const { taskKey = '' } = useParams();
  const { key, myHandle } = useProject();
  const navigate = useNavigate();
  const { board, members, pipeline, model } = useBoardModel();
  const detail = useTaskDetail(key, taskKey);
  const inbox = useInbox(key);
  const resolve = useResolveInbox(key, myHandle);
  const toast = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const close = () => navigate(`/p/${key}`);

  const boardTask = board.data?.tasks.find((task) => task.key === taskKey);
  const task = detail.data?.task ?? boardTask;
  const entry = model?.byKey.get(taskKey);
  useDocumentTitle(task ? `${task.key} ${task.title}` : taskKey, board.data?.project.name);

  useEffect(() => {
    headingRef.current?.focus();
  }, [taskKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) navigate(`/p/${key}`);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [key, navigate]);

  const openIds = useMemo(
    () => new Set((inbox.data?.items ?? []).filter((item) => item.state === 'open').map((item) => item.id)),
    [inbox.data],
  );
  const myItems = (inbox.data?.items ?? []).filter(
    (item) => item.state === 'open' && item.taskKey === taskKey && (!myHandle || item.assignees.includes(myHandle)),
  );

  const body = (() => {
    if (!task) {
      if (detail.isPending || board.isPending) return <LoadingState />;
      if (detail.isError) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
      return <p className={styles.missing}>{t('task.notFound', { key: taskKey })}</p>;
    }
    if (!pipeline || !entry) return <LoadingState />;
    const stage = pipeline.stageById.get(task.stageId);
    const column = pipeline.columnOfStage.get(task.stageId);
    const position = stagePosition(pipeline, task.stageId);
    const stageLabel = column && stage && column.name !== stage.name ? `${column.name} · ${stage.name}` : (stage?.name ?? task.stageId);
    const pr = prChip(task);
    const sessions = detail.data?.sessions ?? [];
    const session = primarySession(task, sessions);
    const isQueued = stage?.kind === 'queue' && task.status !== 'done' && task.status !== 'cancelled' && !task.assignee;
    return (
      <>
        <div className={styles.head}>
          <div className={styles.chips}>
            <Chip tone="accent" size="md">
              {t('task.stageChip', { stage: stageLabel, index: position.index, total: position.total })}
            </Chip>
            {pr ? (
              pr.href ? (
                <a href={pr.href} target="_blank" rel="noreferrer noopener" className={styles.prLink}>
                  <Chip tone="neutral" size="md" icon={pr.merged ? 'prMerged' : 'prOpen'}>
                    {pr.label}
                  </Chip>
                </a>
              ) : (
                <Chip tone="neutral" size="md" icon={pr.merged ? 'prMerged' : 'prOpen'}>
                  {pr.label}
                </Chip>
              )
            ) : null}
            <span className={styles.spacer} />
            <Button variant="muted" iconOnly icon="close" onClick={close} aria-label={t('common.close')} />
          </div>
          <h2 ref={headingRef} tabIndex={-1} className={styles.title}>
            {task.title}
          </h2>
          <div className={styles.facts}>
            <span className={styles.key}>{task.key}</span>
            <span>{t('task.repo', { repo: task.repo ?? t('task.workspaceRoot') })}</span>
            {task.assignee ? <span>{t('task.assignee', { name: nameOf(task.assignee, members, myHandle) })}</span> : null}
            <span>{t(`visibility.${task.visibility}`)}</span>
          </div>
          <StageProgress pipeline={pipeline} stageId={task.stageId} phase={entry.state.phase} variant="stepper" />
          <div className={styles.now} data-phase={entry.state.phase}>
            <StatusDot phase={entry.state.phase} pulse={entry.state.phase === 'working'} size={9} />
            <span className={styles.nowText}>{entry.state.label}</span>
            <span className={styles.nowAge}>{formatAgo(entry.state.since)}</span>
          </div>
        </div>

        <div className={styles.scroll}>
          {myItems.length > 0 ? (
            <section className={styles.section}>
              {myItems.map((item) => (
                <InboxCard
                  key={item.id}
                  item={item}
                  members={members}
                  myHandle={myHandle}
                  pipeline={pipeline}
                  compact
                  headingLevel={3}
                  pending={resolve.isPending && resolve.variables?.item.id === item.id}
                  onResolve={(target, request) =>
                    resolve.mutate(
                      { item: target, body: request },
                      { onError: () => toast.show(t('inbox.resolveFailed'), 'error') },
                    )
                  }
                  detailsHref={item.sessionId ? `/p/${key}/sessions/${item.sessionId}` : null}
                />
              ))}
            </section>
          ) : null}

          {task.description ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>{t('task.description')}</h3>
              <Markdown text={task.description} className={styles.description} />
            </section>
          ) : null}

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{t('task.timeline')}</h3>
            {detail.isPending ? (
              <LoadingState compact />
            ) : detail.isError ? (
              <ErrorState compact error={detail.error} onRetry={() => void detail.refetch()} />
            ) : (
              <Timeline
                events={detail.data.timeline}
                ctx={{ pipeline, members, myHandle, openInboxIds: openIds }}
                next={nextStepText(task, pipeline, members, myHandle)}
              />
            )}
          </section>

          {sessions.length > 0 ? (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>{t('task.sessions')}</h3>
              <ul className={styles.sessions}>
                {[...sessions]
                  .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
                  .map((entrySession) => {
                    const member = members.get(entrySession.member);
                    const status =
                      entrySession.state === 'waiting_permission'
                        ? 'needs_you'
                        : entrySession.state === 'working'
                          ? 'working'
                          : entrySession.state === 'exited'
                            ? 'exited'
                            : entrySession.state === 'failed'
                              ? 'failed'
                              : 'idle';
                    return (
                      <li key={entrySession.id}>
                        <Link to={`/p/${key}/sessions/${entrySession.id}`} className={styles.sessionRow}>
                          <Avatar member={member} handle={entrySession.member} size="md" status={status} />
                          <span className={styles.sessionText}>
                            <span className={styles.sessionName}>{nameOf(entrySession.member, members, myHandle)}</span>
                            <span className={styles.sessionState} data-status={status}>
                              {t(`sessionState.${entrySession.state}`)}
                              {entrySession.activity ? ` · ${entrySession.activity}` : ''}
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
        </div>

        <div className={styles.footer}>
          {isQueued ? (
            <StartPanel task={task} members={members} />
          ) : session ? (
            <>
              <ButtonLink
                to={`/p/${key}/sessions/${session.id}`}
                variant="primary"
                size="xl"
                iconRight="arrowRight"
                className={styles.grow}
              >
                {t('task.openSession')}
              </ButtonLink>
              <ButtonLink to={`/p/${key}/sessions/${session.id}?compose=1`} variant="secondary" size="xl">
                {t('task.message')}
              </ButtonLink>
            </>
          ) : (
            <p className={styles.noSession}>{t('task.noSessions')}</p>
          )}
        </div>
      </>
    );
  })();

  return (
    <aside className={styles.drawer} aria-label={t('task.drawerLabel')}>
      {body}
    </aside>
  );
}

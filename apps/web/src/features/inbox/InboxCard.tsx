import clsx from 'clsx';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { InboxItem, InboxOption, LabelView, ResolveInboxRequest } from '@projectman/shared';
import {
  BoundaryReason,
  isIntegratorTodo,
  alertPayloadOf,
  handOnRequestOf,
  operatorApprovalOf,
  operatorKnowledgeApprovalOf,
  releaseApprovalOf,
  questionPayloadOf,
} from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { Button, ButtonLink } from '../../components/Button';
import type { ButtonVariant } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { formatAgo } from '../../i18n/format';
import { joinNames, t } from '../../i18n/t';
import {
  FREE_ANSWER_OPTION_ID,
  alertText,
  askerStartNote,
  boundaryOf,
  closedReasonOf,
  delegationNote,
  displayKindOf,
  fixLimitDecisionText,
  gateMoveText,
  gateThenMergeText,
  inboxHeading,
  inboxItemDomId,
  isTodo,
  loopDecisionText,
  operatorFallbackOf,
  operatorNoteOf,
  rerouteReasonOf,
  seniorWaitDecisionText,
  optionLabel,
  payloadCode,
  permissionTool,
  questionExtras,
  splitQuestion,
  todoRows,
  withConsequences,
} from '../../lib/inbox';
import type { ApprovalHint } from '../../lib/inbox';
import { labelName } from '../../lib/labels';
import { toolPresentationFor } from '../../lib/chat';
import { nameOf, namesOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import { OperatorApprovalActions, OperatorApprovalBody } from '../operator/OperatorApproval';
import { OperatorKnowledgeBody, OperatorKnowledgeActions } from '../operator/OperatorKnowledgeApproval';
import styles from './InboxCard.module.css';
import { MergeInboxActions, MergeInboxBody } from './MergeInbox';
import { OutageAlert, OutageCheck } from './OutageAlert';
import { ReleaseAlertBody, ReleaseInboxActions, ReleaseInboxBody, isReleaseDown } from './ReleaseInbox';
import { FoldedCommand, PermissionActions } from './PermissionParts';
import { ApprovalHintNote, QuestionBody, QuestionChoices, QuestionDetails, showInboxItem } from './Question';
import { generalQuestionSources, QuestionSources, QuestionSourcesLine } from './QuestionSources';
import { QuestionAttachments } from './QuestionAttachments';
import { IntegratorTodoClock } from './IntegratorTodos';
import { MessageAttachmentTray } from '../messages/MessageAttachmentTray';
import { useMessageAttachmentUploads } from '../messages/useMessageAttachmentUploads';
import { useFileDrop } from '../board/useFileDrop';
import { pasteHasText, pastedImages } from '../../lib/attachmentInput';
import { useIsMobile } from '../../lib/hooks';
import attachmentStyles from '../messages/MessageAttachments.module.css';

const variantFor: Record<InboxOption['style'], ButtonVariant> = {
  primary: 'primary',
  secondary: 'secondary',
  danger: 'danger',
};

export interface InboxCardProps {
  item: InboxItem;
  members: MemberIndex;
  myHandle: string | null;
  /** For stage names of gate decisions. */
  pipeline?: PipelineIndex | null;
  /** For the names of labels an alert speaks of. */
  labels?: readonly LabelView[];
  taskTitle?: string | null;
  onResolve: (item: InboxItem, body: ResolveInboxRequest) => void;
  pending?: boolean;
  detailsHref?: string | null;
  /** Phone layout: full-width 44px buttons. */
  mobile?: boolean;
  /** Smaller card inside the task drawer. */
  compact?: boolean;
  headingLevel?: 2 | 3;
  /** Why the last answer was refused (a closed gate on "Tovább"); shown under the buttons. */
  error?: string | null;
  /** An Operator approval the server just refused as out of date (409); the card says so and offers "Rendben". */
  stale?: boolean;
  /** A question that asks for an approval says its answer sets no label (PM-484); see `approvalHintOf`. */
  approvalHint?: ApprovalHint | null;
  /** The card's drawer, where the approval item of a question stands. */
  cardHref?: string | null;
  /**
   * The card row of an item that has a card (PM-501): `string` makes it a link to the card's drawer, `null`
   * a plain line (the card is not on the board). Left out, the row stays the card's title (the drawer's cards).
   */
  taskHref?: string | null;
  /**
   * The question closed while the viewer had it open (PM-556): the card keeps its place and says so.
   * `closed`: it closed by itself, so with nothing typed and the focus elsewhere `onDismissGone` takes the
   * card away at once; `refused`: the server refused the viewer's answer as the question is closed.
   */
  closedWhileOpen?: 'closed' | 'refused' | null;
  onDismissGone?: () => void;
}

/** The card row: the key (mono, bold) and the title, two lines at most; a link when the card can be opened. */
function TaskRow({ taskKey, title, href }: { taskKey: string; title: string | null; href: string | null }) {
  const text = (
    <span className={styles.taskText}>
      <span className={styles.taskKey}>{taskKey}</span>
      {title ? ` ${title}` : null}
    </span>
  );
  return (
    <p className={clsx(styles.task, styles.taskRow)}>
      {href ? (
        <Link
          to={href}
          className={styles.taskLink}
          data-inbox-card-link=""
          aria-label={
            title
              ? t('inbox.card.openLabel', { key: taskKey, title })
              : t('inbox.card.openLabelKey', { key: taskKey })
          }
        >
          {text}
        </Link>
      ) : (
        text
      )}
    </p>
  );
}

/** The "Vidd tovább" sentence with the next column in bold (PM-461). */
function HandOnText({
  item,
  members,
  myHandle,
  pipeline,
}: {
  item: InboxItem;
  members: MemberIndex;
  myHandle: string | null;
  pipeline?: PipelineIndex | null;
}) {
  const request = handOnRequestOf(item);
  if (!request) return null;
  const stageName = (id: string) => pipeline?.stageById.get(id)?.name ?? id;
  const marker = '\u0000';
  const params = { step: stageName(request.fromStageId), stage: marker };
  const text = t('inbox.handOn.text', {
    ...params,
    owner: nameOf(request.requestedBy, members, myHandle),
  });
  const [before = '', after = ''] = text.split(marker);
  return (
    <p className={styles.body}>
      {before}
      <strong>{stageName(request.toStageId)}</strong>
      {after}
    </p>
  );
}

/** One inbox request, including delegated boundary decisions. */
export function InboxCard({
  item,
  members,
  myHandle,
  pipeline,
  labels = [],
  taskTitle,
  onResolve,
  pending = false,
  detailsHref,
  mobile = false,
  compact = false,
  headingLevel = 2,
  error = null,
  stale = false,
  approvalHint = null,
  cardHref = null,
  taskHref,
  closedWhileOpen = null,
  onDismissGone,
}: InboxCardProps) {
  const operatorApproval = operatorApprovalOf(item);
  const operatorKnowledge = operatorKnowledgeApprovalOf(item);
  const question = questionPayloadOf(item);
  const group = question?.group;
  const grouped = !!group?.sources && group.primaryItemId === item.id;
  const groupAskers = [...new Set(group?.sources?.map((source) => source.asker) ?? [])];
  const groupLiveCount = group?.sources?.filter((source) => source.state === 'live').length ?? 0;
  const hasLiveGeneral = group
    ? generalQuestionSources(group).some((source) => source.state === 'live')
    : false;
  const handOn = handOnRequestOf(item);
  // A question the Operator made a todo of (PM-556): the result field is always open, with two buttons.
  const todo = isTodo(item);
  const answerOption = item.options.find((option) => option.id === FREE_ANSWER_OPTION_ID);
  const choices = withConsequences(
    item,
    item.options.filter((option) => option.id !== FREE_ANSWER_OPTION_ID),
  );
  const allowsFreeAnswer =
    item.kind === 'question' && (answerOption !== undefined || item.options.length === 0);
  const [answering, setAnswering] = useState(todo || (allowsFreeAnswer && choices.length === 0));
  const cardRef = useRef<HTMLElement>(null);
  const [leaving, setLeaving] = useState(false);
  const [answer, setAnswer] = useState('');
  const [answerError, setAnswerError] = useState<string | null>(null);
  const answerId = useId();
  const uploads = useMessageAttachmentUploads(item.projectKey);
  const picker = useRef<HTMLInputElement>(null);
  const answerInput = useRef<HTMLTextAreaElement>(null);
  const isMobile = useIsMobile();
  const addFiles = (files: readonly File[]) => {
    setAnswerError(null);
    uploads.add(files);
  };
  const fileDrop = useFileDrop({
    allowed: answering && !pending && !isMobile && !mobile,
    onFiles: addFiles,
    isolate: true,
  });
  const attachmentIds = answering
    ? uploads.items.flatMap((entry) => (entry.attachment ? [entry.attachment.id] : []))
    : [];
  const answerBlocked = pending || Boolean(answering && uploads.blockedReason);
  const answerHelp = uploads.error ?? uploads.blockedReason ?? answerError;
  const answerHelpError = Boolean(
    uploads.error ||
    uploads.items.some((entry) => entry.status === 'failed') ||
    (!uploads.blockedReason && answerError),
  );
  const resolveAnswer = (body: ResolveInboxRequest) => {
    if (answerBlocked) return;
    onResolve(item, { ...body, ...(attachmentIds.length ? { attachmentIds } : {}) });
  };
  const hasDraft = answer.trim() !== '' || uploads.items.length > 0;
  useEffect(() => {
    if (closedWhileOpen !== 'closed') return;
    const focused = cardRef.current?.contains(document.activeElement) ?? false;
    if (!hasDraft && !focused) onDismissGone?.();
    // Decided once, at the moment the question closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedWhileOpen]);
  const dismissGone = () => {
    const calm =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (calm) {
      onDismissGone?.();
      return;
    }
    setLeaving(true);
    window.setTimeout(() => onDismissGone?.(), 250);
  };
  // Done and "Cannot do it" on a todo: the reason of the second is required (PM-556).
  const pickTodo = (option: InboxOption) => {
    if (answerBlocked) return;
    const text = answer.trim();
    if (option.id === 'todo_cannot' && !text) {
      setAnswerError(t('inbox.todo.reasonRequired'));
      answerInput.current?.focus();
      return;
    }
    setAnswerError(null);
    resolveAnswer({ optionId: option.id, ...(text ? { note: text } : {}) });
  };
  const source = members.get(item.source);
  const code = payloadCode(item);
  const gateMove = item.kind === 'decision' ? gateMoveText(item, pipeline, labels) : null;
  const questionTitle = grouped ? group.combinedQuestion : item.title;
  const heading = gateMove ?? inboxHeading({ ...item, title: questionTitle });
  // An approval a merge follows says that one click is enough (PM-484).
  const thenMerge = gateMove ? gateThenMergeText(item, pipeline, members, myHandle) : null;
  // What follows the short heading of a long question.
  const questionBody = item.kind === 'question' ? splitQuestion(questionTitle).body : null;
  // The tool line is redundant when the heading already names the tool.
  const tool = item.kind === 'permission' && heading === item.title ? permissionTool(item) : null;
  // The task the request is about: the most useful background of the decision, under the header row.
  // A "Vidd tovább" item names the card in its own heading.
  const contextTitle = handOn ? null : taskTitle || (gateMove && item.title ? item.title : null);
  // The card row names the card by its key; it is a link where the page gives an address (never in the drawer).
  const taskRow = grouped ? (
    <QuestionSourcesLine group={group} projectKey={item.projectKey} />
  ) : !handOn && item.taskKey && taskHref !== undefined ? (
    <TaskRow taskKey={item.taskKey} title={taskTitle || null} href={compact ? null : taskHref} />
  ) : contextTitle ? (
    <p className={styles.task}>{contextTitle}</p>
  ) : null;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const assignedToOthers = myHandle !== null && !item.assignees.includes(myHandle);
  const buttonSize = mobile ? 'xl' : 'lg';
  const extras = questionExtras(item);
  // What came with a question from an AI member (PM-556): the Operator's word, why it did not look, why it is asked again.
  const displayKind = displayKindOf(item);
  const open = item.state === 'open';
  const operatorNote = open ? operatorNoteOf(item) : null;
  const steps = todo ? todoRows(item) : [];
  const fallback = open ? operatorFallbackOf(item) : null;
  const rerouted = open ? rerouteReasonOf(item) : null;
  const startNote = open && !assignedToOthers && !grouped ? askerStartNote(item, members, myHandle) : null;
  const boundary = boundaryOf(item);
  const delegation = delegationNote(item, members, myHandle);
  // The system is no member (disk space, loops): it shows as the timeline shows it.
  const fromSystem = item.source === 'system';
  const loopText = loopDecisionText(item, members, myHandle);
  const fixLimitText = fixLimitDecisionText(item, members, myHandle);
  const seniorWaitText = seniorWaitDecisionText(item, members, myHandle);
  const alert = alertText(item, members, myHandle, labels) ?? loopText ?? fixLimitText ?? seniorWaitText;
  // An outage (a provider or an engine that cannot work, PM-468) has its own body, and "Check now".
  const alertPayload = item.kind === 'alert' ? alertPayloadOf(item) : null;
  const outageAlert = alertPayload?.alert === 'work_outage' ? alertPayload : null;
  // The merge request and the alert of a stopped merge (PM-453) tell and act through the card's merge words.
  const mergeItem = item.kind === 'merge_request' || alertPayload?.alert === 'merge_blocked';
  // The proposed release of the instance (PM-492) and the alert of one that failed: both lead to the release card.
  const releaseItem = releaseApprovalOf(item) !== null;
  const releaseAlert = alertPayload?.alert === 'release_failed' ? alertPayload : null;
  const [boundaryReason, setBoundaryReason] = useState<BoundaryReason>('scope_verified');
  // A question that recommends an option or describes what each one does lists its options with
  // that text, and so do a loop, a fix round limit and a Senior wait decision; every other item keeps
  // its row of buttons.
  const describesChoices =
    loopText !== null ||
    fixLimitText !== null ||
    seniorWaitText !== null ||
    (item.kind === 'question' &&
      !todo &&
      (extras.recommendedOptionId !== null || choices.some((option) => option.consequence)));

  const submitAnswer = () => {
    if (answerBlocked) return;
    if (!answer.trim() && !attachmentIds.length) {
      setAnswerError(t('inbox.answerRequired'));
      return;
    }
    setAnswerError(null);
    resolveAnswer({ optionId: FREE_ANSWER_OPTION_ID, note: answer.trim() });
  };

  const attachButton = answering ? (
    <Button
      variant="ghost"
      icon="paperclip"
      size={buttonSize}
      disabled={pending}
      title={t('messageAttachments.addTitle')}
      onClick={() => picker.current?.click()}
    >
      {t('messageAttachments.add')}
    </Button>
  ) : null;

  const headRow = (
    <div className={styles.head}>
      <Chip tone="kind">{t(`inbox.kinds.${displayKind}`)}</Chip>
      {isIntegratorTodo(item) ? (
        <Chip tone="outline" icon="terminal">
          {t('inbox.integrator.chip')}
        </Chip>
      ) : null}
      <span className={styles.requester}>
        {grouped ? (
          <span className={styles.groupAvatars} aria-hidden="true">
            {groupAskers.slice(0, 3).map((asker) => (
              <Avatar key={asker} member={members.get(asker)} handle={asker} size="sm" />
            ))}
            {groupAskers.length > 3 ? <span>+{groupAskers.length - 3}</span> : null}
          </span>
        ) : fromSystem ? (
          <span className={styles.systemIcon} aria-hidden="true">
            <Icon name="layers" size={13} strokeWidth={2} />
          </span>
        ) : (
          <Avatar member={source} handle={item.source} size="sm" isMe={item.source === myHandle} />
        )}
        <span className={styles.source}>
          {grouped
            ? joinNames(namesOf(groupAskers, members, myHandle))
            : fromSystem
              ? t('common.system')
              : nameOf(item.source, members, myHandle)}
        </span>
      </span>
      <span className={styles.spacer} />
      <time className={styles.time} dateTime={item.createdAt}>
        {formatAgo(item.createdAt)}
      </time>
    </div>
  );

  // The question closed while the viewer had it open (PM-556): the card says so and keeps the place until "Rendben".
  if (closedWhileOpen) {
    const reason = closedReasonOf(item);
    return (
      <article
        ref={cardRef}
        id={inboxItemDomId(item.id)}
        className={clsx(
          styles.card,
          styles.gone,
          leaving && styles.leaving,
          compact && styles.compact,
          mobile && styles.mobile,
        )}
        data-kind={displayKind}
        data-recipient={isIntegratorTodo(item) ? 'integrator' : undefined}
      >
        {headRow}
        {taskRow}
        <Heading className={styles.title}>{heading}</Heading>
        <div className={styles.goneBox} role="status">
          <p>
            <strong>
              {reason ? t('inbox.closedWhileOpen.leadWithReason') : t('inbox.closedWhileOpen.leadPlain')}
            </strong>{' '}
            {reason ? t('inbox.closedWhileOpen.withReason', { reason }) : t('inbox.closedWhileOpen.plain')}
          </p>
          <div className={styles.actions}>
            <Button variant="secondary" size={buttonSize} disabled={leaving} onClick={dismissGone}>
              {t('inbox.closedWhileOpen.dismiss')}
            </Button>
          </div>
        </div>
      </article>
    );
  }

  if (group && !grouped) {
    const primaryKey = group.primaryTaskKey;
    return (
      <article id={inboxItemDomId(item.id)} className={clsx(styles.card, styles.groupPointer)}>
        <p>
          {primaryKey
            ? t('inbox.group.pointer', { asker: nameOf(item.source, members, myHandle) })
            : t('inbox.group.pointerPlain')}
        </p>
        {primaryKey ? (
          <Link
            to={`/p/${item.projectKey}/tasks/${primaryKey}#${inboxItemDomId(group.primaryItemId)}`}
            onClick={(event) => {
              const target = document.getElementById(inboxItemDomId(group.primaryItemId));
              if (target) {
                event.preventDefault();
                showInboxItem(target);
              }
            }}
          >
            {t('inbox.group.pointerJump', { key: primaryKey })}
          </Link>
        ) : null}
      </article>
    );
  }

  if (operatorKnowledge)
    return (
      <article
        id={inboxItemDomId(item.id)}
        className={clsx(styles.card, compact && styles.compact, mobile && styles.mobile)}
        data-kind={item.kind}
        data-operator-knowledge=""
      >
        <div className={styles.head}>
          <Chip tone="kind">
            {t(
              operatorKnowledge.change.kind === 'agreement_replace'
                ? 'knowledge.proposal.agreement'
                : 'knowledge.proposal.principle',
            )}
          </Chip>
        </div>
        <Heading className={styles.title}>{item.title}</Heading>
        <OperatorKnowledgeBody payload={operatorKnowledge} stale={stale} />
        {item.state === 'open' ? (
          <OperatorKnowledgeActions
            item={item}
            payload={operatorKnowledge}
            pending={pending}
            stale={stale}
            onDecide={onResolve}
          />
        ) : null}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </article>
    );
  // An Operator proposal (PM-447): the request, what changes and the consequence, then its own buttons.
  if (operatorApproval) {
    const isStale = operatorApproval.stale !== null || stale;
    return (
      <article
        id={inboxItemDomId(item.id)}
        className={clsx(styles.card, compact && styles.compact, mobile && styles.mobile)}
        data-kind={item.kind}
        data-operator-approval=""
      >
        <div className={styles.head}>
          <Chip tone="kind">{t(`inbox.kinds.${item.kind}`)}</Chip>
          {isStale ? <Chip tone="needs">{t('operator.approval.stale')}</Chip> : null}
          <Avatar member={source} handle={item.source} size="sm" isMe={item.source === myHandle} />
          <span className={styles.source}>{nameOf(item.source, members, myHandle)}</span>
          <span className={styles.spacer} />
          <time className={styles.time} dateTime={item.createdAt}>
            {formatAgo(item.createdAt)}
          </time>
        </div>
        {taskRow}
        <Heading className={styles.title}>{item.title}</Heading>
        <OperatorApprovalBody payload={operatorApproval} stale={stale} open={item.state === 'open'} />
        {assignedToOthers ? (
          <p className={styles.others}>
            <Icon name="user" size={14} />
            {t('inbox.assignedTo', { names: joinNames(namesOf(item.assignees, members, myHandle)) })}
          </p>
        ) : (
          <div className={styles.actions}>
            <OperatorApprovalActions
              item={item}
              payload={operatorApproval}
              size={buttonSize}
              pending={pending}
              stale={stale}
              onDecide={onResolve}
            />
            {detailsHref && !mobile ? (
              <>
                <span className={styles.spacer} />
                <Link to={detailsHref} className={styles.details}>
                  <span>{t('inbox.details')}</span>
                  <Icon name="arrowRight" size={14} strokeWidth={2.2} />
                </Link>
              </>
            ) : null}
          </div>
        )}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </article>
    );
  }

  return (
    <article
      ref={cardRef}
      id={inboxItemDomId(item.id)}
      className={clsx(styles.card, compact && styles.compact, mobile && styles.mobile)}
      data-kind={displayKind}
      data-alert={outageAlert ? 'work_outage' : releaseAlert ? 'release_failed' : undefined}
      data-recipient={isIntegratorTodo(item) ? 'integrator' : undefined}
      data-severity={releaseAlert && isReleaseDown(releaseAlert) ? 'down' : undefined}
    >
      {headRow}
      {taskRow}
      {question?.integratorEscalatedAt ? (
        <p className={styles.integratorMoved}>
          <Icon name="handoff" size={16} />
          {t('inbox.integrator.moved')}
        </p>
      ) : null}
      <Heading className={styles.title} tabIndex={-1} data-inbox-title="">
        {heading}
      </Heading>
      {thenMerge ? <p className={styles.body}>{thenMerge}</p> : null}
      {questionBody ? <QuestionBody text={questionBody} mobile={mobile} /> : null}
      {approvalHint ? (
        <ApprovalHintNote
          hint={approvalHint}
          labelName={labelName(approvalHint.label, labels)}
          approverNames={
            approvalHint.kind === 'others'
              ? joinNames(namesOf(approvalHint.approvers, members, myHandle))
              : ''
          }
          cardHref={cardHref ?? null}
          mobile={mobile}
        />
      ) : null}
      {boundary ? (
        <div>
          <p>
            {t(`boundary.operations.${boundary.target.operation}`)} · <code>{boundary.target.resource}</code>
          </p>
          <p>
            {t(`boundary.categories.${boundary.category}`)} · {t(`boundary.states.${boundary.state}`)}
          </p>
          <p>
            {t('boundary.environment', {
              environment: t(`boundary.environments.${boundary.target.environment}`),
            })}
          </p>
          {boundary.target.branch ? <p>{t('boundary.branch', { branch: boundary.target.branch })}</p> : null}
          <p>{t('boundary.scope')}</p>
          <p>{t('boundary.expiry', { time: new Date(boundary.expiresAt).toLocaleString('hu-HU') })}</p>
          {boundary.state === 'pending_lead' ? (
            <p>{t('boundary.deadline', { time: new Date(boundary.leadDeadline).toLocaleString('hu-HU') })}</p>
          ) : null}
          <label>
            {t('boundary.reason')}{' '}
            <select
              value={boundaryReason}
              onChange={(event) => setBoundaryReason(BoundaryReason.parse(event.target.value))}
            >
              {BoundaryReason.options.map((reason) => (
                <option key={reason} value={reason}>
                  {t(`boundary.reasons.${reason}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {handOn ? <HandOnText item={item} members={members} myHandle={myHandle} pipeline={pipeline} /> : null}
      {mergeItem ? <MergeInboxBody item={item} /> : null}
      {releaseItem ? <ReleaseInboxBody item={item} /> : null}
      {releaseAlert ? <ReleaseAlertBody alert={releaseAlert} /> : null}
      {alert ? <p className={styles.body}>{alert}</p> : null}
      {outageAlert ? (
        <OutageAlert alert={outageAlert} members={members} myHandle={myHandle} mobile={mobile} />
      ) : null}
      {item.body &&
      !mergeItem &&
      !releaseItem &&
      !releaseAlert &&
      loopText === null &&
      fixLimitText === null &&
      seniorWaitText === null ? (
        item.kind === 'approval' ? (
          <blockquote className={styles.preview}>{item.body}</blockquote>
        ) : (
          <p className={styles.body}>{item.body}</p>
        )
      ) : null}
      {extras.details ? <QuestionDetails text={extras.details} /> : null}
      <QuestionAttachments item={item} projectKey={item.projectKey} />
      {steps.length > 0 ? (
        <section className={styles.steps} aria-labelledby={`${answerId}-steps`}>
          <h3 id={`${answerId}-steps`} className={styles.stepsTitle}>
            {t('inbox.todo.stepTitle')}
          </h3>
          <dl className={styles.stepsList}>
            {steps.map((row) => (
              <Fragment key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      ) : null}
      {isIntegratorTodo(item) ? <IntegratorTodoClock item={item} /> : null}
      {grouped && group.note ? (
        <p className={styles.operatorNote}>
          <span aria-hidden="true">
            <Avatar
              member={members.get(question?.screening?.by ?? '')}
              handle={question?.screening?.by ?? ''}
              size="xs"
            />
          </span>
          <span>
            <strong>{nameOf(question?.screening?.by ?? '', members, myHandle)}:</strong> {group.note}
          </span>
        </p>
      ) : operatorNote ? (
        <p className={styles.operatorNote}>
          <span className={styles.operatorAvatar} aria-hidden="true">
            OP
          </span>
          <span>
            <strong>{t('inbox.operatorNote')}</strong> {operatorNote}
          </span>
        </p>
      ) : null}
      {grouped ? (
        <QuestionSources group={group} projectKey={item.projectKey} members={members} myHandle={myHandle} />
      ) : null}
      {fallback ? <p className={styles.note}>{t(`inbox.operatorFallback.${fallback}`)}</p> : null}
      {rerouted ? <p className={styles.note}>{t('inbox.rerouted', { reason: rerouted })}</p> : null}
      {startNote ? <p className={styles.note}>{startNote}</p> : null}
      {code ? (
        <div className={styles.codeWrap}>
          {tool ? (
            <span className={styles.tool}>
              {t('inbox.tool', { tool: toolPresentationFor(tool, code ?? '').label })}
            </span>
          ) : null}
          <FoldedCommand text={code} className={styles.code} />
        </div>
      ) : null}
      {delegation ? <p className={styles.others}>{delegation}</p> : null}
      {assignedToOthers ? (
        <p className={styles.others}>
          <Icon name="user" size={14} />
          {t('inbox.assignedTo', { names: joinNames(namesOf(item.assignees, members, myHandle)) })}
        </p>
      ) : null}
      {grouped ? (
        <p id={`${answerId}-fanout`} className={styles.note}>
          {t(
            groupLiveCount === 1
              ? 'inbox.group.fanoutOne'
              : hasLiveGeneral
                ? 'inbox.group.fanoutMixed'
                : 'inbox.group.fanout',
            {
              count: groupLiveCount,
            },
          )}
        </p>
      ) : null}
      {describesChoices && !assignedToOthers ? (
        <QuestionChoices
          describedBy={grouped ? `${answerId}-fanout` : undefined}
          choices={choices}
          recommendedOptionId={extras.recommendedOptionId}
          recommendationReason={extras.recommendationReason}
          size={buttonSize}
          mobile={mobile}
          disabled={answerBlocked}
          variantOf={(option) =>
            answering ? 'secondary' : option.style === 'danger' ? 'dangerSolid' : variantFor[option.style]
          }
          onPick={(option) => resolveAnswer({ optionId: option.id })}
        />
      ) : null}
      {answering ? (
        <div className={styles.answer} {...fileDrop.props} data-message-composer="">
          {fileDrop.state && !isMobile && !mobile ? (
            <div className={attachmentStyles.drop} aria-hidden="true">
              {t('attachments.dropActive')}
            </div>
          ) : null}
          <label htmlFor={answerId} className={styles.answerLabel}>
            {todo ? (
              <>
                {t('inbox.todo.resultLabel')}{' '}
                <span className={styles.optional}>{t('inbox.todo.resultOptional')}</span>
              </>
            ) : (
              t('inbox.answerLabel')
            )}
          </label>
          <textarea
            ref={answerInput}
            id={answerId}
            className={styles.answerInput}
            rows={2}
            value={answer}
            placeholder={todo ? t('inbox.todo.resultPlaceholder') : t('inbox.answerPlaceholder')}
            onChange={(event) => {
              setAnswer(event.target.value);
              if (todo) setAnswerError(null);
            }}
            aria-invalid={answerError ? true : undefined}
            aria-describedby={answerHelp ? `${answerId}-error` : undefined}
            onPaste={(event) => {
              event.stopPropagation();
              if (pasteHasText(event.clipboardData)) return;
              const images = pastedImages(event.clipboardData);
              if (!images.length) return;
              event.preventDefault();
              if (!pending) addFiles(images);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submitAnswer();
            }}
          />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (!pending) addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <MessageAttachmentTray
            items={uploads.items}
            onRemove={uploads.remove}
            onRetry={uploads.retry}
            focusInput={() => answerInput.current?.focus()}
            disabled={pending}
          />
          {answerHelp ? (
            <span
              id={`${answerId}-error`}
              className={answerHelpError ? styles.answerError : styles.answerHint}
              aria-live="polite"
              role={answerHelpError ? 'alert' : undefined}
            >
              {answerHelp}
            </span>
          ) : null}
        </div>
      ) : null}
      {loopText !== null && !assignedToOthers ? (
        <p className={styles.others}>{t('inbox.loop.footer')}</p>
      ) : null}
      {fixLimitText !== null && !assignedToOthers ? (
        <p className={styles.others}>{t('inbox.fixLimit.footer')}</p>
      ) : null}
      {seniorWaitText !== null && !assignedToOthers ? (
        <p className={styles.others}>{t('inbox.seniorWait.footer')}</p>
      ) : null}
      {assignedToOthers ? null : releaseItem ? (
        <ReleaseInboxActions
          item={item}
          size={buttonSize}
          pending={pending}
          detailsHref={detailsHref}
          onResolve={onResolve}
        />
      ) : mergeItem ? (
        <MergeInboxActions
          item={item}
          size={buttonSize}
          pending={pending}
          detailsHref={detailsHref}
          onResolve={onResolve}
        />
      ) : handOn ? (
        <div className={clsx(styles.actions, styles.handOnActions)}>
          <Button
            variant="primary"
            size={buttonSize}
            disabled={pending}
            onClick={() => onResolve(item, { optionId: 'move' })}
          >
            {t('inbox.handOn.move', {
              stage: pipeline?.stageById.get(handOn.toStageId)?.name ?? handOn.toStageId,
            })}
          </Button>
          {detailsHref ? (
            <ButtonLink to={detailsHref} variant="secondary" size={buttonSize}>
              {t('inbox.handOn.open')}
            </ButtonLink>
          ) : null}
        </div>
      ) : (
        <div
          role={grouped ? 'group' : undefined}
          aria-describedby={grouped ? `${answerId}-fanout` : undefined}
          className={clsx(
            styles.actions,
            item.kind === 'permission' && styles.actionsTop,
            todo && styles.todoActions,
          )}
        >
          {answering && !todo ? (
            <Button variant="primary" size={buttonSize} onClick={submitAnswer} disabled={answerBlocked}>
              {t('inbox.answerSubmit')}
            </Button>
          ) : null}
          {todo ? null : attachButton}
          {item.kind === 'permission' ? (
            <PermissionActions
              options={choices}
              size={buttonSize}
              disabled={pending}
              onPick={(option) => onResolve(item, { optionId: option.id })}
            />
          ) : describesChoices ? null : (
            <>
              {alertPayload?.alert === 'feedback_forwarded' ? (
                <ButtonLink
                  to={`/p/${item.projectKey}/feedback/${alertPayload.markId}`}
                  variant="primary"
                  size={buttonSize}
                >
                  {t('inbox.alerts.feedback_forwarded.open')}
                </ButtonLink>
              ) : null}
              {choices.map((option) => (
                <Button
                  key={option.id}
                  variant={
                    todo
                      ? option.id === 'todo_done'
                        ? 'primary'
                        : 'ghost'
                      : answering || alertPayload?.alert === 'feedback_forwarded'
                        ? 'secondary'
                        : variantFor[option.style]
                  }
                  size={buttonSize}
                  disabled={answerBlocked}
                  onClick={() =>
                    todo
                      ? pickTodo(option)
                      : resolveAnswer({ optionId: option.id, ...(boundary ? { note: boundaryReason } : {}) })
                  }
                >
                  {optionLabel(option)}
                </Button>
              ))}
            </>
          )}
          {todo ? attachButton : null}
          {outageAlert && item.state === 'open' ? (
            <OutageCheck item={item} size={buttonSize === 'xl' ? 'xl' : 'lg'} />
          ) : null}
          {allowsFreeAnswer && !answering ? (
            <Button variant="ghost" size={buttonSize} onClick={() => setAnswering(true)} disabled={pending}>
              {answerOption ? optionLabel(answerOption) : t('inbox.answerOwn')}
            </Button>
          ) : null}
          {detailsHref && !mobile ? (
            <>
              <span className={styles.spacer} />
              <Link to={detailsHref} className={styles.details}>
                <span>{t('inbox.details')}</span>
                <Icon name="arrowRight" size={14} strokeWidth={2.2} />
              </Link>
            </>
          ) : null}
        </div>
      )}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {detailsHref && mobile && !handOn && !mergeItem ? (
        <Link to={detailsHref} className={styles.details}>
          <span>{t('inbox.details')}</span>
          <Icon name="arrowRight" size={14} strokeWidth={2.2} />
        </Link>
      ) : null}
    </article>
  );
}

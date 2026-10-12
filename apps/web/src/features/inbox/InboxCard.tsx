import clsx from 'clsx';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import type { InboxItem, InboxOption, LabelView, ResolveInboxRequest } from '@projectman/shared';
import {
  BoundaryReason,
  alertPayloadOf,
  handOnRequestOf,
  operatorApprovalOf,
  releaseApprovalOf,
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
  boundaryOf,
  delegationNote,
  fixLimitDecisionText,
  gateMoveText,
  gateThenMergeText,
  inboxHeading,
  inboxItemDomId,
  loopDecisionText,
  seniorWaitDecisionText,
  optionLabel,
  payloadCode,
  permissionTool,
  questionExtras,
  splitQuestion,
  withConsequences,
} from '../../lib/inbox';
import type { ApprovalHint } from '../../lib/inbox';
import { labelName } from '../../lib/labels';
import { toolPresentationFor } from '../../lib/chat';
import { nameOf, namesOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import { OperatorApprovalActions, OperatorApprovalBody } from '../operator/OperatorApproval';
import styles from './InboxCard.module.css';
import { MergeInboxActions, MergeInboxBody } from './MergeInbox';
import { OutageAlert, OutageCheck } from './OutageAlert';
import { ReleaseAlertBody, ReleaseInboxActions, ReleaseInboxBody, isReleaseDown } from './ReleaseInbox';
import { FoldedCommand, PermissionActions } from './PermissionParts';
import { ApprovalHintNote, QuestionBody, QuestionChoices, QuestionDetails } from './Question';
import { QuestionAttachments } from './QuestionAttachments';

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
}: InboxCardProps) {
  const operatorApproval = operatorApprovalOf(item);
  const handOn = handOnRequestOf(item);
  const answerOption = item.options.find((option) => option.id === FREE_ANSWER_OPTION_ID);
  const choices = withConsequences(
    item,
    item.options.filter((option) => option.id !== FREE_ANSWER_OPTION_ID),
  );
  const allowsFreeAnswer =
    item.kind === 'question' && (answerOption !== undefined || item.options.length === 0);
  const [answering, setAnswering] = useState(allowsFreeAnswer && choices.length === 0);
  const [answer, setAnswer] = useState('');
  const [answerError, setAnswerError] = useState<string | null>(null);
  const answerId = useId();
  const source = members.get(item.source);
  const code = payloadCode(item);
  const gateMove = item.kind === 'decision' ? gateMoveText(item, pipeline, labels) : null;
  const heading = gateMove ?? inboxHeading(item);
  // An approval a merge follows says that one click is enough (PM-484).
  const thenMerge = gateMove ? gateThenMergeText(item, pipeline, members, myHandle) : null;
  // What follows the short heading of a long question.
  const questionBody = item.kind === 'question' ? splitQuestion(item.title).body : null;
  // The tool line is redundant when the heading already names the tool.
  const tool = item.kind === 'permission' && heading === item.title ? permissionTool(item) : null;
  // The task the request is about: the most useful background of the decision, under the header row.
  // A "Vidd tovább" item names the card in its own heading.
  const contextTitle = handOn ? null : taskTitle || (gateMove && item.title ? item.title : null);
  // The card row names the card by its key; it is a link where the page gives an address (never in the drawer).
  const taskRow =
    !handOn && item.taskKey && taskHref !== undefined ? (
      <TaskRow taskKey={item.taskKey} title={taskTitle || null} href={compact ? null : taskHref} />
    ) : contextTitle ? (
      <p className={styles.task}>{contextTitle}</p>
    ) : null;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const assignedToOthers = myHandle !== null && !item.assignees.includes(myHandle);
  const buttonSize = mobile ? 'xl' : 'lg';
  const extras = questionExtras(item);
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
      (extras.recommendedOptionId !== null || choices.some((option) => option.consequence)));

  const submitAnswer = () => {
    if (!answer.trim()) {
      setAnswerError(t('inbox.answerRequired'));
      return;
    }
    setAnswerError(null);
    onResolve(item, { optionId: FREE_ANSWER_OPTION_ID, note: answer.trim() });
  };

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
        <OperatorApprovalBody payload={operatorApproval} stale={stale} />
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
      id={inboxItemDomId(item.id)}
      className={clsx(styles.card, compact && styles.compact, mobile && styles.mobile)}
      data-kind={item.kind}
      data-alert={outageAlert ? 'work_outage' : releaseAlert ? 'release_failed' : undefined}
      data-severity={releaseAlert && isReleaseDown(releaseAlert) ? 'down' : undefined}
    >
      <div className={styles.head}>
        <Chip tone="kind">{t(`inbox.kinds.${item.kind}`)}</Chip>
        {fromSystem ? (
          <span className={styles.systemIcon} aria-hidden="true">
            <Icon name="layers" size={13} strokeWidth={2} />
          </span>
        ) : (
          <Avatar member={source} handle={item.source} size="sm" isMe={item.source === myHandle} />
        )}
        <span className={styles.source}>
          {fromSystem ? t('common.system') : nameOf(item.source, members, myHandle)}
        </span>
        <span className={styles.spacer} />
        <time className={styles.time} dateTime={item.createdAt}>
          {formatAgo(item.createdAt)}
        </time>
      </div>
      {taskRow}
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
      {describesChoices && !assignedToOthers ? (
        <QuestionChoices
          choices={choices}
          recommendedOptionId={extras.recommendedOptionId}
          recommendationReason={extras.recommendationReason}
          size={buttonSize}
          mobile={mobile}
          disabled={pending}
          variantOf={(option) =>
            answering ? 'secondary' : option.style === 'danger' ? 'dangerSolid' : variantFor[option.style]
          }
          onPick={(option) => onResolve(item, { optionId: option.id })}
        />
      ) : null}
      {answering ? (
        <div className={styles.answer}>
          <label htmlFor={answerId} className={styles.answerLabel}>
            {t('inbox.answerLabel')}
          </label>
          <textarea
            id={answerId}
            className={styles.answerInput}
            rows={2}
            value={answer}
            placeholder={t('inbox.answerPlaceholder')}
            onChange={(event) => setAnswer(event.target.value)}
            aria-invalid={answerError ? true : undefined}
            aria-describedby={answerError ? `${answerId}-error` : undefined}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submitAnswer();
            }}
          />
          {answerError ? (
            <span id={`${answerId}-error`} className={styles.answerError} role="alert">
              {answerError}
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
        <div className={clsx(styles.actions, item.kind === 'permission' && styles.actionsTop)}>
          {answering ? (
            <Button variant="primary" size={buttonSize} onClick={submitAnswer} disabled={pending}>
              {t('inbox.answerSubmit')}
            </Button>
          ) : null}
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
                    answering || alertPayload?.alert === 'feedback_forwarded'
                      ? 'secondary'
                      : variantFor[option.style]
                  }
                  size={buttonSize}
                  disabled={pending}
                  onClick={() =>
                    onResolve(item, { optionId: option.id, ...(boundary ? { note: boundaryReason } : {}) })
                  }
                >
                  {optionLabel(option)}
                </Button>
              ))}
            </>
          )}
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

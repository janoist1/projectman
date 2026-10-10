import clsx from 'clsx';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import type { InboxItem, InboxOption, LabelView, ResolveInboxRequest } from '@projectman/shared';
import { BoundaryReason, alertPayloadOf } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
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
  inboxHeading,
  loopDecisionText,
  seniorWaitDecisionText,
  optionLabel,
  payloadCode,
  permissionTool,
  questionExtras,
  splitQuestion,
  withConsequences,
} from '../../lib/inbox';
import { toolPresentationFor } from '../../lib/chat';
import { nameOf, namesOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import styles from './InboxCard.module.css';
import { OutageAlert, OutageCheck } from './OutageAlert';
import { FoldedCommand, PermissionActions } from './PermissionParts';
import { QuestionBody, QuestionChoices, QuestionDetails } from './Question';

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
}: InboxCardProps) {
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
  // What follows the short heading of a long question.
  const questionBody = item.kind === 'question' ? splitQuestion(item.title).body : null;
  // The tool line is redundant when the heading already names the tool.
  const tool = item.kind === 'permission' && heading === item.title ? permissionTool(item) : null;
  // The task the request is about: the most useful background of the decision, under the header row.
  const contextTitle = taskTitle || (gateMove && item.title ? item.title : null);
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

  return (
    <article
      className={clsx(styles.card, compact && styles.compact, mobile && styles.mobile)}
      data-kind={item.kind}
      data-alert={outageAlert ? 'work_outage' : undefined}
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
      {contextTitle ? <p className={styles.task}>{contextTitle}</p> : null}
      <Heading className={styles.title}>{heading}</Heading>
      {questionBody ? <QuestionBody text={questionBody} mobile={mobile} /> : null}
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
      {alert ? <p className={styles.body}>{alert}</p> : null}
      {outageAlert ? (
        <OutageAlert alert={outageAlert} members={members} myHandle={myHandle} mobile={mobile} />
      ) : null}
      {item.body && loopText === null && fixLimitText === null && seniorWaitText === null ? (
        item.kind === 'approval' ? (
          <blockquote className={styles.preview}>{item.body}</blockquote>
        ) : (
          <p className={styles.body}>{item.body}</p>
        )
      ) : null}
      {extras.details ? <QuestionDetails text={extras.details} /> : null}
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
      {assignedToOthers ? null : (
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
            choices.map((option) => (
              <Button
                key={option.id}
                variant={answering ? 'secondary' : variantFor[option.style]}
                size={buttonSize}
                disabled={pending}
                onClick={() =>
                  onResolve(item, { optionId: option.id, ...(boundary ? { note: boundaryReason } : {}) })
                }
              >
                {optionLabel(option)}
              </Button>
            ))
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
      {detailsHref && mobile ? (
        <Link to={detailsHref} className={styles.details}>
          <span>{t('inbox.details')}</span>
          <Icon name="arrowRight" size={14} strokeWidth={2.2} />
        </Link>
      ) : null}
    </article>
  );
}

import { useLayoutEffect, useRef, useState } from 'react';
import type { HostRequestOutcome, HostRequestView } from '@projectman/shared';
import { useAnswerHostRequest } from '../../../api/queries';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { TextAreaField } from '../../../components/Field';
import { Fold } from '../../../components/Fold';
import { useToast } from '../../../components/toastContext';
import { formatAgo } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorCode, errorMessage } from '../../../lib/errors';
import styles from './owners.module.css';

function RequestBody({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      if (!expanded) setOverflows(element.scrollHeight > element.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <>
      <p ref={ref} className={`${styles.text} ${expanded ? '' : styles.clamped}`}>
        {text}
      </p>
      {overflows && (
        <Button
          variant="ghost"
          className={styles.more}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {t(expanded ? 'hostRequests.less' : 'hostRequests.more')}
        </Button>
      )}
    </>
  );
}

export function HostRequestsCard({ requests }: { requests: HostRequestView[] }) {
  const [reply, setReply] = useState<{ id: string; outcome: HostRequestOutcome } | null>(null);
  const [answer, setAnswer] = useState('');
  const [stale, setStale] = useState(false);
  const mutation = useAnswerHostRequest();
  const toast = useToast();
  const open = requests.filter((r) => r.state === 'open');
  const closed = requests.filter((r) => r.state !== 'open');
  function choose(id: string, outcome: HostRequestOutcome) {
    if (mutation.isPending) return;
    mutation.reset();
    setStale(false);
    setAnswer('');
    setReply({ id, outcome });
  }
  const row = (request: HostRequestView) => (
    <li key={request.id} className={styles.row}>
      <div className={styles.body}>
        <strong className={styles.text}>{request.title}</strong>
        <p className={styles.meta}>
          {t('hostRequests.source', {
            key: request.projectKey,
            project: request.projectName,
            pm: request.openedBy,
            owners: request.owners.join(', '),
            time: formatAgo(request.createdAt),
          })}
        </p>
        <RequestBody text={request.body} />
        {request.state === 'open' ? (
          reply?.id === request.id ? (
            <div
              className={styles.reply}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  if (!mutation.isPending) setReply(null);
                }
              }}
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!answer.trim() || mutation.isPending) return;
                  mutation.mutate(
                    { id: request.id, body: { outcome: reply.outcome, answer: answer.trim() } },
                    {
                      onSuccess: () => {
                        toast.show(
                          t(
                            reply.outcome === 'answered'
                              ? 'hostRequests.answeredToast'
                              : 'hostRequests.declinedToast',
                          ),
                        );
                        setReply(null);
                      },
                      onError: (error) => {
                        if (['host_request_closed', 'not_found'].includes(errorCode(error) ?? '')) {
                          setStale(true);
                          setReply(null);
                        }
                      },
                    },
                  );
                }}
              >
                <TextAreaField
                  autoFocus
                  label={t(
                    reply.outcome === 'answered' ? 'hostRequests.answerLabel' : 'hostRequests.declineLabel',
                  )}
                  hint={t('hostRequests.hint')}
                  maxLength={4000}
                  value={answer}
                  disabled={mutation.isPending}
                  onChange={(event) => setAnswer(event.target.value)}
                />
                {mutation.isError && <ErrorBanner>{errorMessage(mutation.error)}</ErrorBanner>}
                <div className={styles.actions}>
                  <Button
                    type="submit"
                    size="md"
                    variant={reply.outcome === 'answered' ? 'primary' : 'dangerSolid'}
                    disabled={!answer.trim()}
                    loading={mutation.isPending}
                  >
                    {t(reply.outcome === 'answered' ? 'hostRequests.sendAnswer' : 'hostRequests.sendDecline')}
                  </Button>
                  <Button size="md" disabled={mutation.isPending} onClick={() => setReply(null)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            </div>
          ) : (
            <div className={styles.actions}>
              <Button
                size="md"
                variant="primary"
                disabled={mutation.isPending}
                onClick={() => choose(request.id, 'answered')}
              >
                {t('hostRequests.answer')}
              </Button>
              <Button size="md" disabled={mutation.isPending} onClick={() => choose(request.id, 'declined')}>
                {t('hostRequests.decline')}
              </Button>
            </div>
          )
        ) : (
          <>
            <Chip
              tone={
                request.state === 'answered' ? 'ok' : request.state === 'declined' ? 'blocked' : 'outline'
              }
            >
              {t(`hostRequests.${request.state}`)}
            </Chip>
            {request.answer && <blockquote className={styles.text}>{request.answer}</blockquote>}
          </>
        )}
      </div>
    </li>
  );
  return (
    <>
      {stale && (
        <p className={styles.meta} role="status">
          {t('hostRequests.stale')}
        </p>
      )}
      {open.length ? (
        <ul className={styles.list} aria-label={t('hostRequests.title')}>
          {open.map(row)}
        </ul>
      ) : (
        <p className={styles.meta}>{t('hostRequests.empty')}</p>
      )}
      {closed.length > 0 && (
        <Fold summary={t('hostRequests.closedFold', { n: closed.length })}>
          <ul className={styles.list} aria-label={t('hostRequests.closedFold', { n: closed.length })}>
            {closed.map(row)}
          </ul>
        </Fold>
      )}
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  APPROVAL_OWNER_TOPIC,
  OwnerQuestionRoute,
  UNKNOWN_OWNER_TOPIC,
  ownerDecisionTopicsOf,
} from '@projectman/shared';
import type { OwnerQuestionWeek, OwnerTopic, ProjectConfig } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useConfig } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Fold } from '../../components/Fold';
import { Icon } from '../../components/Icon';
import { ErrorState } from '../../components/States';
import { formatDayRange, formatStamp } from '../../i18n/format';
import { t, tDynamic } from '../../i18n/t';
import { ownerTopicLabel } from '../../lib/ownerTopics';
import { useOwnerQuestions } from './useOwnerQuestions';
import styles from './OperatorWeekly.module.css';

/** A topic's name: the unknown topic's text, otherwise the owner topic's name. */
function topicLabel(id: string, config: Pick<ProjectConfig, 'team'> | undefined): string {
  return id === UNKNOWN_OWNER_TOPIC ? t('operator.weekly.unknownTopic') : ownerTopicLabel(id, config);
}

/** A number in the week's row, named for a screen reader by the column it stands under. */
function Count({ label, count }: { label: string; count: number }) {
  return (
    <span className={styles.count}>
      <span className="visually-hidden">{label}: </span>
      {count}
    </span>
  );
}

/** The project's topics in their order, then approval and the unknown one, then any other id the weeks name. */
function topicOrder(weeks: readonly OwnerQuestionWeek[], topics: readonly OwnerTopic[]): string[] {
  const ids = [...topics.map((topic) => topic.id), APPROVAL_OWNER_TOPIC, UNKNOWN_OWNER_TOPIC];
  for (const week of weeks) for (const id of Object.keys(week.byTopic)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

function Breakdown({ rows }: { rows: { id: string; label: string; count: number }[] }) {
  return (
    <dl className={styles.breakdown}>
      {rows.map((row) => (
        <div key={row.id}>
          <dt>{row.label}</dt>
          <dd>{row.count}</dd>
        </div>
      ))}
    </dl>
  );
}

function WeekRow({
  week,
  current,
  config,
  topicIds,
}: {
  week: OwnerQuestionWeek;
  current: boolean;
  config: Pick<ProjectConfig, 'team'> | undefined;
  topicIds: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.week} open={open}>
      <summary
        className={styles.weekSummary}
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          setOpen(!open);
        }}
      >
        <span className={styles.weekTitle}>
          <span>
            {t('operator.weekly.weekNumber', { week: week.isoWeek })}
            {current ? <span className={styles.tag}>{t('operator.weekly.current')}</span> : null}
          </span>
          <small>{formatDayRange(week.weekStart, week.weekEnd)}</small>
        </span>
        <Count label={t('operator.weekly.total')} count={week.total} />
        <Count label={t('operator.weekly.viaIntegrator')} count={week.answeredByIntegrator} />
        <Icon name="chevronRight" size={16} strokeWidth={2.2} className={styles.chevron} />
      </summary>
      <div className={styles.weekBody}>
        {week.total > 0 ? (
          <>
            <div className={styles.facts}>
              <p>
                <b>{week.answeredByOwner}</b>
                {t('operator.weekly.answeredByOwner')}
              </p>
              <p>
                <b>{week.open}</b>
                {t('operator.weekly.open')}
              </p>
            </div>
            <p className={styles.muted}>{t('operator.weekly.answerHint')}</p>
            <h4>{t('operator.weekly.byRoute')}</h4>
            <Breakdown
              rows={OwnerQuestionRoute.options.map((route) => ({
                id: route,
                label: tDynamic(`operator.weekly.routes.${route}`, route),
                count: week.byRoute[route],
              }))}
            />
            <h4>{t('operator.weekly.byTopic')}</h4>
            <Breakdown
              rows={topicIds.map((id) => ({
                id,
                label: topicLabel(id, config),
                count: week.byTopic[id] ?? 0,
              }))}
            />
          </>
        ) : (
          <p className={styles.note}>{t('operator.weekly.emptyWeek')}</p>
        )}
        <div className={styles.separate}>
          <p className={styles.between}>
            <strong>{t('operator.weekly.integratorTodos')}</strong>
            <b>{week.integratorTodos}</b>
          </p>
          <p className={styles.muted}>{t('operator.weekly.integratorTodosHint')}</p>
        </div>
      </div>
    </details>
  );
}

/**
 * The owner's weekly question measure (PM-1192): how many questions reached the owner in the project's last
 * weeks, by route and topic, and how many of them the integrator answered for them. A subview of the panel,
 * like the knowledge view and the queue; only for an owner's own login.
 */
export function OperatorWeeklyView({ onBack }: { onBack: () => void }) {
  const { key } = useProject();
  const report = useOwnerQuestions(key);
  const config = useConfig(key);
  const title = useRef<HTMLHeadingElement>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => title.current?.focus(), []);

  const denied = isApiError(report.error) && report.error.status === 403;
  const data = denied ? undefined : report.data;
  const weeks = data?.weeks ?? [];
  const topics = config.data ? ownerDecisionTopicsOf(config.data.config) : [];
  const topicIds = topicOrder(weeks, topics);
  const count = data?.weeks.length ?? 0;
  const empty = weeks.length > 0 && weeks.every((week) => week.total === 0 && week.integratorTodos === 0);
  const oldest = weeks.at(-1);
  const newest = weeks[0];
  const refresh = () => {
    setAnnouncement('');
    void report.refetch().then((result) => {
      if (!result.isError) setAnnouncement(t('operator.weekly.refreshed'));
    });
  };

  return (
    <div className={styles.view}>
      <Button variant="ghost" size="lg" icon="chevronLeft" className={styles.back} onClick={onBack}>
        {t('operator.weekly.back')}
      </Button>
      <h3 ref={title} tabIndex={-1} className={styles.title}>
        {t('operator.weekly.title')}
      </h3>
      <p className={styles.muted}>{t('operator.weekly.intro')}</p>
      {denied ? (
        <p className={styles.message} role="alert">
          {t('operator.weekly.denied')}
        </p>
      ) : report.isPending ? (
        <div className={styles.loading}>
          <p role="status">{t('operator.weekly.loading')}</p>
          <div className={styles.skeleton} aria-hidden="true">
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
        </div>
      ) : !data ? (
        <div className={styles.failed}>
          <ErrorState compact error={report.error} message={t('operator.weekly.failed')} />
          <Button variant="secondary" size="lg" icon="undo" onClick={refresh}>
            {t('operator.weekly.retry')}
          </Button>
        </div>
      ) : (
        <>
          {newest && oldest ? (
            <div className={styles.meta}>
              <strong>
                {t('operator.weekly.range', {
                  weeks: count,
                  range: formatDayRange(oldest.weekStart, newest.weekEnd, true),
                })}
              </strong>
              <span className={styles.muted}>
                {t('operator.weekly.timezone', { timezone: data.timezone })}
              </span>
            </div>
          ) : null}
          {report.isError ? (
            <div className={styles.failed}>
              <ErrorState compact error={report.error} message={t('operator.weekly.stale')} />
              <Button
                variant="secondary"
                size="lg"
                icon="undo"
                disabled={report.isFetching}
                onClick={refresh}
              >
                {t('operator.weekly.retry')}
              </Button>
            </div>
          ) : null}
          {empty ? (
            <div className={styles.message}>
              <strong>{t('operator.weekly.empty', { weeks: count })}</strong>
              <p>{t('operator.weekly.firstUse')}</p>
            </div>
          ) : null}
          <div className={styles.toolbar}>
            <span className={styles.muted}>
              {t('operator.weekly.updated', { date: formatStamp(new Date(report.dataUpdatedAt)) })}
            </span>
            <Button
              variant="secondary"
              size="lg"
              icon="refresh"
              disabled={report.isFetching}
              aria-busy={report.isFetching}
              onClick={refresh}
            >
              {t(report.isFetching ? 'operator.weekly.refreshing' : 'operator.weekly.refresh')}
            </Button>
          </div>
          <div className={styles.legend} aria-hidden="true">
            <span>{t('operator.weekly.week')}</span>
            <span>{t('operator.weekly.total')}</span>
            <span>{t('operator.weekly.viaIntegrator')}</span>
          </div>
          <div className={styles.weeks}>
            {weeks.map((week, index) => (
              <WeekRow
                key={week.weekStart}
                week={week}
                current={index === 0}
                config={config.data?.config}
                topicIds={topicIds}
              />
            ))}
          </div>
          <Fold summary={t('operator.weekly.method')} className={styles.method}>
            <p>{t('operator.weekly.methodWeeks', { previous: Math.max(count - 1, 0) })}</p>
            <p>{t('operator.weekly.methodAnswers')}</p>
            <p>{t('operator.weekly.methodTopics')}</p>
          </Fold>
        </>
      )}
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
    </div>
  );
}

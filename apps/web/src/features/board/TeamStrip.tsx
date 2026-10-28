import { useId } from 'react';
import { Link } from 'react-router';
import type { MemberView, Task } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { capacityChip, capacityOf, onlyCardKey } from '../../lib/capacity';
import type { Capacity } from '../../lib/capacity';
import { cardsLine, memberStatusView, workingNow } from '../../lib/members';
import { usePausedRows } from '../pause/usePause';
import styles from './TeamStrip.module.css';

interface TeamStripProps {
  members: readonly MemberView[];
  /** Task titles by key of the cards on the board; a chip names only these. */
  titles: ReadonlyMap<string, string>;
  /** The cards on the board: those that wait for a member's place put that member in the strip too (PM-297). */
  tasks?: readonly Task[];
}

/** The cards that wait for a member's places, with what holds those places (PM-297). */
function waitedFor(tasks: readonly Task[]): Map<string, { cards: Task[]; capacity: Capacity }> {
  const waited = new Map<string, { cards: Task[]; capacity: Capacity }>();
  for (const task of tasks) {
    const capacity = capacityOf(task.startWaiting);
    const handle = task.startWaiting?.member;
    if (!capacity || !handle) continue;
    const entry = waited.get(handle);
    if (entry) entry.cards.push(task);
    else waited.set(handle, { cards: [task], capacity });
  }
  return waited;
}

/** Who works on a card right now, and on which; the whole team is on the Team page. */
export function TeamStrip({ members, titles, tasks = [] }: TeamStripProps) {
  const { key } = useProject();
  const labelId = useId();
  const pausedRows = usePausedRows();
  if (!members.some((member) => member.kind === 'ai' && member.status !== 'retired')) return null;
  const working = new Map(
    workingNow(members, new Set(titles.keys())).map((entry) => [entry.member.handle, entry]),
  );
  const waited = waitedFor(tasks);
  const entries = members
    .filter((member) => member.kind === 'ai' && (working.has(member.handle) || waited.has(member.handle)))
    .map((member) => ({
      member,
      keys: working.get(member.handle)?.keys ?? [],
      waited: waited.get(member.handle),
    }));

  if (entries.length === 0) {
    return (
      <section aria-label={t('board.workingNow')} className={styles.strip}>
        <p className={styles.empty}>
          {t('board.nobodyWorking')}
          <Link to={`/p/${key}/team`} className={styles.teamLink}>
            {t('board.teamLink')}
            <Icon name="chevronRight" size={14} strokeWidth={2.4} />
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby={labelId} className={styles.strip}>
      <span id={labelId} className={styles.title}>
        {t('board.workingNow')}
      </span>
      <ul className={styles.list}>
        {entries.map(({ member, keys, waited: wait }) => {
          // A member a card waits for shows what holds their places in place of the cards they work on.
          const holderKey = wait ? onlyCardKey(wait.capacity) : null;
          const onlyKey = wait ? holderKey : keys.length === 1 ? keys[0]! : null;
          const cardTitle = onlyKey ? titles.get(onlyKey) : undefined;
          const chip = wait ? capacityChip(wait.capacity) : null;
          const cards = wait
            ? [chip?.keys, chip?.kinds].filter(Boolean).join(t('common.listSeparator'))
            : (cardsLine(keys, titles) ?? '');
          const mark = wait
            ? wait.cards.length === 1
              ? t('board.waitedFor', { key: wait.cards[0]!.key })
              : t('board.waitedForMany', { count: wait.cards.length })
            : null;
          const view = memberStatusView(member, undefined, null, pausedRows);
          const pauseLabel = view.status === 'paused' ? view.label : null;
          const titleKeys = wait ? wait.cards.map((card) => card.key) : keys;
          return (
            <li key={member.handle}>
              <Link
                to={onlyKey ? `/p/${key}/tasks/${onlyKey}` : `/p/${key}/team/${member.handle}`}
                className={styles.chip}
                title={titleKeys
                  .map((cardKey) => `${cardKey} ${titles.get(cardKey) ?? ''}`.trim())
                  .join('\n')}
                aria-label={`${
                  wait && mark
                    ? t('board.waitedForChip', { name: member.displayName, holders: cards, waiting: mark })
                    : t('board.workingChip', { name: member.displayName, cards })
                }${pauseLabel ? ` · ${pauseLabel}` : ''}`}
              >
                <Avatar member={member} size="sm" />
                <span className={styles.name}>{member.displayName}</span>
                {pauseLabel ? (
                  <span className={styles.pauseTag}>
                    <Icon name="pause" size={12} strokeWidth={2.4} />
                    {pauseLabel}
                  </span>
                ) : null}
                {wait ? (
                  <>
                    {chip?.keys ? <span className={styles.key}>{chip.keys}</span> : null}
                    {chip?.kinds ? (
                      <span className={styles.kind}>
                        {chip.keys ? '· ' : ''}
                        {chip.kinds}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className={styles.key}>{onlyKey ?? cardsLine(keys, new Map())}</span>
                )}
                {cardTitle ? <span className={styles.cardTitle}>{cardTitle}</span> : null}
                {mark ? (
                  <span className={styles.pauseTag}>
                    <Icon name="clock" size={12} strokeWidth={2.4} />
                    {mark}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

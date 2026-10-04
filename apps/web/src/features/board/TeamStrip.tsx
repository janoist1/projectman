import { useId } from 'react';
import { Link } from 'react-router';
import type { MemberView } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { cardsLine, memberStatusView, workingNow } from '../../lib/members';
import { usePausedRows } from '../pause/usePause';
import styles from './TeamStrip.module.css';

interface TeamStripProps {
  members: readonly MemberView[];
  /** Task titles by key of the cards on the board; a chip names only these. */
  titles: ReadonlyMap<string, string>;
}

/** Who works on a card right now, and on which; the whole team is on the Team page. */
export function TeamStrip({ members, titles }: TeamStripProps) {
  const { key } = useProject();
  const labelId = useId();
  const pausedRows = usePausedRows();
  if (!members.some((member) => member.kind === 'ai' && member.status !== 'retired')) return null;
  const working = workingNow(members, new Set(titles.keys()));

  if (working.length === 0) {
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
        {working.map(({ member, keys }) => {
          const onlyKey = keys.length === 1 ? keys[0]! : null;
          const cardTitle = onlyKey ? titles.get(onlyKey) : undefined;
          const cards = cardsLine(keys, titles) ?? '';
          const view = memberStatusView(member, undefined, null, pausedRows);
          const pauseLabel = view.status === 'paused' ? view.label : null;
          return (
            <li key={member.handle}>
              <Link
                to={onlyKey ? `/p/${key}/tasks/${onlyKey}` : `/p/${key}/team/${member.handle}`}
                className={styles.chip}
                title={keys.map((cardKey) => `${cardKey} ${titles.get(cardKey) ?? ''}`.trim()).join('\n')}
                aria-label={`${t('board.workingChip', { name: member.displayName, cards })}${pauseLabel ? ` · ${pauseLabel}` : ''}`}
              >
                <Avatar member={member} size="sm" />
                <span className={styles.name}>{member.displayName}</span>
                {pauseLabel ? (
                  <span className={styles.pauseTag}>
                    <Icon name="pause" size={12} strokeWidth={2.4} />
                    {pauseLabel}
                  </span>
                ) : null}
                <span className={styles.key}>{onlyKey ?? cardsLine(keys, new Map())}</span>
                {cardTitle ? <span className={styles.cardTitle}>{cardTitle}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

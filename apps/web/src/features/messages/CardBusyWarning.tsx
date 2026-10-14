import clsx from 'clsx';
import { useCallback, useMemo } from 'react';
import type { RefObject } from 'react';
import { CardBusyDetails } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useRoles } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { t } from '../../i18n/t';
import styles from './CardBusyWarning.module.css';

/** The collision a refused send names (409 `card_busy`); null for any other error or unreadable details. */
export function refusedCardBusy(error: unknown): CardBusyDetails | null {
  if (!isApiError(error) || error.code !== 'card_busy') return null;
  const parsed = CardBusyDetails.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

/** The dot colour of a working member's state; the state text beside it carries the meaning. */
function dotClass(state: string): string {
  const tone =
    state === 'working' || state === 'starting'
      ? 'dotWorking'
      : state === 'waiting_permission' || state === 'waiting_input'
        ? 'dotWaiting'
        : 'dotIdle';
  return clsx(styles.dot, styles[tone]);
}

/**
 * The warning before a message puts an AI member on a card a same-role member already works on
 * (PM-663): it names who works there and who the message would bring, and the sender goes back to
 * the recipients or sends anyway.
 */
export function CardBusyWarning({
  details,
  loading,
  onConfirm,
  onBack,
  returnFocus,
}: {
  details: CardBusyDetails;
  /** The resend is on its way: nothing closes the warning. */
  loading?: boolean;
  onConfirm: () => void;
  onBack: () => void;
  /** Where the focus goes back to when the sender steps back: the message box. */
  returnFocus?: () => HTMLElement | null;
}) {
  const { key } = useProject();
  const { members } = useProjectIndexes(key);
  const roles = useRoles(key);
  const anyWorking = details.groups.some((group) => group.working.length > 0);
  const focusBack = useCallback((element: HTMLButtonElement | null) => element?.focus(), []);
  const returnFocusRef = useMemo(
    () =>
      ({
        get current() {
          return returnFocus?.() ?? null;
        },
      }) as RefObject<HTMLElement | null>,
    [returnFocus],
  );
  const person = (handle: string) => {
    const member = members.get(handle);
    return (
      <>
        <Avatar member={member} handle={handle} size="sm" />
        <span className={styles.who}>
          {member ? <span>{member.displayName}</span> : null} <small>{handle}</small>
        </span>
      </>
    );
  };
  const close = () => {
    if (!loading) onBack();
  };
  return (
    <Dialog
      open
      onClose={close}
      title={t(anyWorking ? 'cardBusyWarning.titleWorking' : 'cardBusyWarning.titleJoining')}
      description={t('cardBusyWarning.description', { taskKey: details.taskKey })}
      size="sm"
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button ref={focusBack} variant="secondary" size="md" disabled={loading} onClick={onBack}>
            {t('cardBusyWarning.back')}
          </Button>
          <Button
            variant="primary"
            size="md"
            className={styles.confirm}
            loading={loading}
            onClick={onConfirm}
          >
            {t('cardBusyWarning.confirm')}
          </Button>
        </>
      }
    >
      <div className={styles.groups}>
        {details.groups.map((group) => {
          const name = roles.data?.roles.find((role) => role.id === group.role)?.name ?? group.role;
          return (
            <section key={group.role} className={styles.group} aria-label={name}>
              <h3 className={styles.groupName}>{name}</h3>
              {group.working.length > 0 ? (
                <>
                  <p className={styles.sub}>{t('cardBusyWarning.working')}</p>
                  <ul className={styles.list}>
                    {group.working.map((worker) => (
                      <li key={worker.handle} className={styles.row}>
                        {person(worker.handle)}
                        <span className={styles.state}>
                          <span className={dotClass(worker.state)} aria-hidden="true" />
                          {t(`sessionState.${worker.state}`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <p className={styles.sub}>{t('cardBusyWarning.joining')}</p>
              <ul className={styles.list}>
                {group.joining.map((handle) => (
                  <li key={handle} className={styles.row}>
                    {person(handle)}
                    <span className={styles.joiningMark}>{t('cardBusyWarning.joiningMark')}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}

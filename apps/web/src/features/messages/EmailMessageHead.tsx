import type { TeamMessage } from '@projectman/shared';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import styles from './EmailMessageHead.module.css';

/** The head of a message that came in by e-mail (PM-945, PM-989): the marker and the subject. */
export function EmailMessageHead({ email }: { email: NonNullable<TeamMessage['email']> }) {
  return (
    <div className={styles.head}>
      <span className={styles.mark}>
        <Icon name="mail" size={13} strokeWidth={2} />
        {t('messages.email.received')}
      </span>
      {email.subject ? (
        <strong className={styles.subject} title={email.subject}>
          {email.subject}
        </strong>
      ) : null}
    </div>
  );
}

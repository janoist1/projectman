import { useProjects, useLogout } from '../../api/queries';
import { Button, ButtonLink } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { readStorage } from '../../lib/hooks';
import { t } from '../../i18n/t';
import authStyles from '../auth/AuthLayout.module.css';
import styles from './Pairing.module.css';

/** State 4: the code is being looked up. The title keeps the focus; the skeleton stands in for the facts. */
export function LoadingView() {
  return (
    <div className={authStyles.skeletons} aria-busy="true">
      <div className={authStyles.skeleton} />
      <div className={authStyles.skeleton} />
      <div className={`${authStyles.skeleton} ${authStyles.skeletonButton}`} />
    </div>
  );
}

/** Where the machines are listed: the last visited project's settings, else the first one, else the welcome page. */
function useEnginesTarget(): string | null {
  const projects = useProjects();
  if (projects.isPending) return null;
  const list = projects.data ?? [];
  const project = list.find((item) => item.key === readStorage('lastProject')) ?? list[0];
  return project ? `/p/${project.key}/settings/engines` : '/welcome';
}

/** State 8: the machine got its keys. */
export function DoneView() {
  const target = useEnginesTarget();
  return (
    <div className={styles.result}>
      <span className={styles.doneMark} aria-hidden="true">
        <Icon name="check" size={22} />
      </span>
      <p>{t('pairing.done.body')}</p>
      {target ? (
        <ButtonLink to={target} variant="primary" size="xl" fullWidth className={styles.action}>
          {t('pairing.done.open')}
        </ButtonLink>
      ) : null}
    </div>
  );
}

/** State 9. */
export function DeniedView() {
  return (
    <div className={styles.result}>
      <p>{t('pairing.denied.body')}</p>
    </div>
  );
}

/** State 10: the code ran out, by the clock or by the server's word. */
export function ExpiredView({ onAgain }: { onAgain: () => void }) {
  return (
    <div className={styles.result}>
      <p>{t('pairing.expired.body')}</p>
      <Button variant="primary" size="xl" fullWidth className={styles.action} onClick={onAgain}>
        {t('pairing.expired.again')}
      </Button>
    </div>
  );
}

/** State 11: this account may not approve. Logging out lands on the login page, which brings the link back. */
export function NoRightView() {
  const logout = useLogout();
  return (
    <div className={styles.result}>
      <p>{t('pairing.noRight.body')}</p>
      <Button
        variant="primary"
        size="xl"
        fullWidth
        className={styles.action}
        loading={logout.isPending}
        aria-disabled={logout.isPending || undefined}
        onClick={() => logout.mutate()}
      >
        {logout.isPending ? t('pairing.noRight.loggingOut') : t('pairing.noRight.login')}
      </Button>
    </div>
  );
}

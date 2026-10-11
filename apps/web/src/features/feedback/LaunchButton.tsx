import type { FeedbackSurfaceView } from '@projectman/shared';
import { useLaunchFeedback } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import type { ButtonSize, ButtonVariant } from '../../components/Button';
import { Popover } from '../../components/Popover';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { originHost } from './feedbackModel';
import styles from './LaunchButton.module.css';

/**
 * Opens a surface of the product in a new tab with the marker switched on under the viewer's name.
 * The tab opens at once, inside the click (else the browser takes it for a pop-up), and gets its
 * address when the server has handed out the one-time code; the page opened must not reach back to
 * this one, so its opener is cut first.
 */
export function useLaunchSurface() {
  const { key } = useProject();
  const launch = useLaunchFeedback(key);
  const toast = useToast();
  const open = (surfaceId: string, markId?: string) => {
    const tab = window.open('', '_blank');
    launch.mutate(markId ? { surfaceId, markId } : { surfaceId }, {
      onSuccess: ({ url }) => {
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        } else {
          window.open(url, '_blank', 'noopener');
        }
      },
      onError: (error) => {
        tab?.close();
        toast.show(errorMessage(error), 'error');
      },
    });
  };
  return { open, pending: launch.isPending };
}

/** "Jelölés az oldalon ↗": one surface opens at once, several open a menu of them. */
export function LaunchButton({
  surfaces,
  variant = 'primary',
  size = 'md',
}: {
  surfaces: readonly FeedbackSurfaceView[];
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const { open, pending } = useLaunchSurface();
  const usable = surfaces.filter((surface) => surface.name !== null);
  if (usable.length === 0) return null;
  if (usable.length === 1) {
    return (
      <Button
        variant={variant}
        size={size}
        icon="external"
        loading={pending}
        onClick={() => open(usable[0]!.id)}
      >
        {t('feedback.launch.button')}
      </Button>
    );
  }
  return (
    <Popover label={t('feedback.launch.button')} icon="external" variant={variant} size={size} align="right">
      {(close) => (
        <div className={styles.menu}>
          <p className={styles.title}>{t('feedback.launch.menuTitle')}</p>
          <p className={styles.hint}>{t('feedback.launch.menuHint')}</p>
          <ul className={styles.list}>
            {usable.map((surface) => (
              <li key={surface.id}>
                <button
                  type="button"
                  className={styles.surface}
                  onClick={() => {
                    close();
                    open(surface.id);
                  }}
                >
                  <span className={styles.name}>{surface.name}</span>
                  <span className={styles.origin}>{originHost(surface.origin)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Popover>
  );
}

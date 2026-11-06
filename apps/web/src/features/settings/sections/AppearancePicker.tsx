import { useEffect, useState } from 'react';
import type { UiStyle } from '@projectman/shared';
import { useSetUiStyle } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { Icon } from '../../../components/Icon';
import { t } from '../../../i18n/t';
import {
  applyUiStyle,
  clearUiStylePending,
  markUiStylePending,
  pendingUiStyle,
  storedUiStyle,
} from '../../../lib/uiStyle';
import styles from './AppearancePicker.module.css';

const CHOICES: { style: UiStyle; name: () => string; summary: () => string }[] = [
  {
    style: 'classic',
    name: () => t('settings.account.appearance.classic'),
    summary: () => t('settings.account.appearance.classicSummary'),
  },
  {
    style: 'win311',
    name: () => t('settings.account.appearance.win311'),
    summary: () => t('settings.account.appearance.win311Summary'),
  },
];

/**
 * The user's choice of interface style (PM-363): two cards, one radio group. A click switches this device at
 * once; the account keeps the choice so every device shows the same style. When saving fails the style stays on
 * this device and a line offers a retry (it also retries when the connection returns).
 */
export function AppearancePicker() {
  const { me } = useProject();
  const save = useSetUiStyle();
  const [current, setCurrent] = useState<UiStyle>(pendingUiStyle() ?? me.uiStyle ?? storedUiStyle());
  const [unsaved, setUnsaved] = useState(pendingUiStyle() !== null);

  // The choice is marked pending until the account has it: a reload or a lost connection does not lose it.
  const persist = (style: UiStyle) => {
    markUiStylePending(style);
    save.mutate(
      { style },
      {
        onSuccess: () => {
          clearUiStylePending(style);
          setUnsaved(false);
        },
        onError: () => setUnsaved(true),
      },
    );
  };

  const choose = (style: UiStyle) => {
    setCurrent(style);
    applyUiStyle(style);
    persist(style);
  };

  useEffect(() => {
    if (!unsaved) return;
    const retry = () => persist(current);
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
    // `persist` only closes over `save`, whose `mutate` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsaved, current]);

  return (
    <div className={styles.picker}>
      <h3 id="appearance-title" className={styles.title}>
        {t('settings.account.appearance.title')}
      </h3>
      <div role="radiogroup" aria-labelledby="appearance-title" className={styles.choices}>
        {CHOICES.map((choice) => (
          <label key={choice.style} className={styles.choice} data-checked={current === choice.style}>
            <input
              type="radio"
              name="ui-style"
              className={styles.input}
              checked={current === choice.style}
              onChange={() => choose(choice.style)}
            />
            <span className={styles.preview} data-preview={choice.style} aria-hidden="true">
              <span className={styles.previewBar} />
              <span className={styles.previewBody}>
                <span className={styles.previewCard} />
                <span className={styles.previewCard} />
              </span>
            </span>
            <span className={styles.name}>
              {choice.name()}
              {current === choice.style ? <Icon name="check" size={16} className={styles.tick} /> : null}
            </span>
            <span className={styles.summary}>{choice.summary()}</span>
          </label>
        ))}
      </div>
      {unsaved ? (
        <p className={styles.unsaved} role="status">
          {t('settings.account.appearance.saveFailed')}{' '}
          <button type="button" className={styles.retry} onClick={() => persist(current)}>
            {t('settings.account.appearance.retry')}
          </button>
        </p>
      ) : null}
    </div>
  );
}

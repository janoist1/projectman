import { useSyncExternalStore } from 'react';
import type { UiLanguage } from '@projectman/shared';
import { currentLanguage, subscribeLanguage } from './language';

/** The UI language, re-read when it changes. */
export function useLanguage(): UiLanguage {
  return useSyncExternalStore(subscribeLanguage, currentLanguage, currentLanguage);
}

import { useQueryClient } from '@tanstack/react-query';
import type { Me, UiLanguage } from '@projectman/shared';
import { api } from '../api/endpoints';
import { queryKeys } from '../api/queryKeys';
import { useToast } from '../components/toastContext';
import { currentLanguage, setCurrentLanguage } from '../i18n/language';
import { t } from '../i18n/t';

/**
 * Switches the interface language at once. Logged in, the account's language is saved in the
 * background (the cached `Me` already holds the new one, so no refetch flips it back); when the
 * save fails the language returns and a toast says so in the restored language. Before login only
 * the stored choice changes.
 */
export function useChangeLanguage(): (next: UiLanguage) => void {
  const client = useQueryClient();
  const toast = useToast();
  return (next) => {
    const previous = currentLanguage();
    if (next === previous) return;
    const me = client.getQueryData<Me>(queryKeys.me);
    if (me) client.setQueryData<Me>(queryKeys.me, { ...me, language: next });
    setCurrentLanguage(next);
    if (!me) return;
    api.setLanguage({ language: next }).then(
      (saved) => client.setQueryData<Me>(queryKeys.me, saved),
      () => {
        // A newer choice made meanwhile stays.
        if (currentLanguage() !== next) return;
        client.setQueryData<Me>(queryKeys.me, { ...me, language: previous });
        setCurrentLanguage(previous);
        toast.show(t('language.saveFailed'), 'error');
      },
    );
  };
}

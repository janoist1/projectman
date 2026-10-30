import { useRef } from 'react';
import type { UiLanguage } from '@projectman/shared';
import { SegmentedControl } from '../components/SegmentedControl';
import type { SegmentOption } from '../components/SegmentedControl';
import { t } from '../i18n/t';
import { useLanguage } from '../i18n/useLanguage';
import { focusAfterLanguageChange, useRestoredLanguageFocus } from './languageFocus';
import type { LanguageFocusTarget } from './languageFocus';
import { useChangeLanguage } from './useChangeLanguage';

/** Each language is named in itself and marked with its `lang`, so a screen reader pronounces it right. */
function languageOptions(): SegmentOption<UiLanguage>[] {
  return [
    { value: 'en', label: t('language.names.en'), lang: 'en' },
    { value: 'hu', label: t('language.names.hu'), lang: 'hu' },
  ];
}

/**
 * The two-way language switch (PM-1168), in the account menu and on the pages before login. The change
 * remounts the routes; `focusTarget` is the control that takes the focus back afterwards: the account
 * menu's avatar button (`account`, which asks for it itself) or this switch (`switch`).
 */
export function LanguageSwitch({ focusTarget }: { focusTarget: LanguageFocusTarget }) {
  const language = useLanguage();
  const change = useChangeLanguage();
  const ref = useRef<HTMLDivElement>(null);
  useRestoredLanguageFocus('switch', () => ref.current?.querySelector<HTMLElement>('[aria-checked="true"]'));
  return (
    <div ref={ref}>
      <SegmentedControl
        label={t('language.label')}
        options={languageOptions()}
        value={language}
        size="sm"
        asRadioGroup
        onChange={(next) => {
          if (next === language) return;
          focusAfterLanguageChange(focusTarget);
          change(next);
        }}
      />
    </div>
  );
}

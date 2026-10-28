import { SETTINGS_SECTIONS } from '@projectman/shared';
import type { SettingsSection } from '@projectman/shared';

export { SETTINGS_SECTIONS };
export type SettingsSectionId = SettingsSection;
export const SETTINGS_WIDE_QUERY = '(min-width: 1280px)';

export function isSettingsSection(value: string | undefined): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section === value);
}

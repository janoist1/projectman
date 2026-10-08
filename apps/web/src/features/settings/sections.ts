export const SETTINGS_SECTIONS = [
  'pipeline',
  'labels',
  'duties',
  'team',
  'limits',
  'project',
  'repos',
  'history',
  'providers',
  'integrator',
  'account',
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];
export const SETTINGS_WIDE_QUERY = '(min-width: 1280px)';

export function isSettingsSection(value: string | undefined): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section === value);
}

import { Navigate, Route, Routes } from 'react-router';
import { SettingsPage } from './SettingsPage';
import type { SettingsSectionId } from './sections';
import { useConfig } from '../../api/queries';
import { SettingsEditingProvider } from './SettingsEditor';
import { ProjectSection } from './sections/ProjectSection';
import { LimitsSection } from './sections/LimitsSection';
import { DutiesMatrix } from './DutiesMatrix';

/** Regression coverage of the provider's cross-editor lock, independent of page layout. */
export function SettingsEditingFixture() {
  const query = useConfig('AC');
  const view = query.data;
  if (!view) return null;
  return (
    <SettingsEditingProvider view={view} reload={async () => (await query.refetch()).data}>
      <ProjectSection config={view.config} />
      <LimitsSection config={view.config} />
      <DutiesMatrix key={view.version} config={view.config} version={view.version} />
    </SettingsEditingProvider>
  );
}

/** The real settings route shape, inside mockProject's MemoryRouter. */
export function SettingsTestRoutes({ initialSection = 'project' }: { initialSection?: SettingsSectionId }) {
  return (
    <Routes>
      <Route path="/p/AC/settings" element={<SettingsPage />} />
      <Route path="/p/AC/settings/:section" element={<SettingsPage />} />
      <Route path="*" element={<Navigate replace to={`/p/AC/settings/${initialSection}`} />} />
    </Routes>
  );
}

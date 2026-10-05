import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLocation } from 'react-router';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { SETTINGS_SECTIONS, SETTINGS_WIDE_QUERY } from './sections';
import { SettingsTestRoutes } from './testRoutes';
import { useSettingsSelection } from './selection';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});
function Fixture() {
  const location = useLocation();
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <SettingsTestRoutes />
    </>
  );
}
describe('settings navigation', () => {
  it('shows summaries and restores the list focus after visiting a narrow section', async () => {
    const project = mockProject();
    project.render(<Fixture />, '/p/AC/settings');
    const nav = screen.getByRole('navigation', { name: t('settings.nav.label') });
    const { stages, columns } = project.backend.config.pipeline;
    expect(
      await within(nav).findByText(
        t('settings.summary.pipeline', { stages: stages.length, columns: columns.length }),
      ),
    ).toBeTruthy();
    const link = within(nav).getByRole('link', { name: new RegExp(t('settings.nav.project')) });
    fireEvent.click(link);
    const heading = await screen.findByRole('heading', { name: t('settings.sections.project') });
    expect(document.activeElement).toBe(heading);
    expect(document.title).toBe(
      `${t('settings.nav.project')} · ${t('settings.title')} · ${project.backend.config.project.name} · projectman`,
    );
    expect(screen.queryByText(t('settings.version'))).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: t('settings.backLabel') }));
    expect(document.activeElement?.id).toBe('settings-nav-project');
  });
  it.each([...SETTINGS_SECTIONS, 'problems'])('replaces legacy anchor %s', async (section) => {
    mockProject().render(<Fixture />, `/p/AC/settings#settings-${section}`);
    expect(screen.getByTestId('location').textContent).toBe(
      `/p/AC/settings/${section === 'problems' ? 'pipeline' : section}`,
    );
    await screen.findByRole('link', { name: t('settings.backLabel') });
  });
  it('replaces an unknown section with the narrow list', async () => {
    mockProject().render(<Fixture />, '/p/AC/settings/unknown');
    expect(screen.getByTestId('location').textContent).toBe('/p/AC/settings');
    expect(screen.getByRole('navigation', { name: t('settings.nav.label') })).toBeTruthy();
  });
  it('replaces the wide index with pipeline and keeps navigation visible', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === SETTINGS_WIDE_QUERY,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      onchange: null,
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    mockProject().render(<Fixture />, '/p/AC/settings');
    expect(screen.getByTestId('location').textContent).toBe('/p/AC/settings/pipeline');
    const nav = screen.getByRole('navigation', { name: t('settings.nav.label') });
    expect(
      within(nav)
        .getByRole('link', { name: t('settings.nav.pipeline') })
        .getAttribute('aria-current'),
    ).toBe('page');
    await screen.findByRole('region', { name: t('settings.sections.pipeline') });
  });
  it('targets issues, marks the list and hides links into the current section', async () => {
    const project = mockProject();
    const label = project.backend.config.pipeline.labels[0]!;
    project.backend.config.pipeline.labels.push({ ...label });
    project.render(<Fixture />, '/p/AC/settings');
    const open = await screen.findByRole('link', {
      name: t('settings.problems.openLabel', { name: label.name }),
    });
    expect(open.getAttribute('href')).toBe(`/p/AC/settings/labels?show=label%3A${label.id}`);
    expect(screen.getByLabelText(t('settings.problems.mark', { n: 1 }))).toBeTruthy();
    fireEvent.click(open);
    expect(
      screen.queryByRole('link', { name: t('settings.problems.openLabel', { name: label.name }) }),
    ).toBeNull();
    expect(document.activeElement?.id).toBe('settings-labels');
  });
  it('keeps the account available when configuration cannot load', async () => {
    const project = mockProject();
    setFetchImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: 'config_error', message: 'Unavailable' } }), {
          status: 500,
        }),
    );
    project.render(<Fixture />, '/p/AC/settings');
    expect(await screen.findByText(t('settings.loadError'))).toBeTruthy();
    expect(screen.getByText(t('errors.details'))).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('navigation')).getByRole('link', {
        name: new RegExp(t('settings.nav.account')),
      }),
    );
    expect(await screen.findByRole('region', { name: t('settings.sections.account') })).toBeTruthy();
    expect(screen.queryByText(t('settings.loadError'))).toBeNull();
  });
  it('focuses the target heading after opening an issue on desktop', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === SETTINGS_WIDE_QUERY,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      onchange: null,
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    const project = mockProject();
    const label = project.backend.config.pipeline.labels[0]!;
    project.backend.config.pipeline.labels.push({ ...label });
    project.render(<Fixture />, '/p/AC/settings/project');
    const link = await screen.findByRole('link', {
      name: t('settings.problems.openLabel', { name: label.name }),
    });
    link.focus();
    fireEvent.click(link);
    expect(document.activeElement?.id).toBe('settings-labels');
  });
  it('keeps section focus handling out of panel selection changes', async () => {
    function SelectionControl() {
      const selection = useSettingsSelection();
      return <button onClick={() => selection.open({ type: 'stage', id: 'dev' })}>Select item</button>;
    }
    mockProject().render(
      <>
        <SelectionControl />
        <Fixture />
      </>,
      '/p/AC/settings/pipeline',
    );
    await screen.findByRole('heading', { name: t('settings.sections.pipeline') });
    const opener = screen.getByText('Select item');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(opener);
  });
});

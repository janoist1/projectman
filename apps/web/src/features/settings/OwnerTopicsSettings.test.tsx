import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { SettingsTestRoutes } from './testRoutes';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
const group = async () =>
  within(await screen.findByRole('region', { name: t('settings.team.ownerTopics.title') }));

it('saves a built-in toggle and an own topic, then deletes it', async () => {
  const project = mockProject();
  project.render(<SettingsTestRoutes initialSection="team" />);
  const section = await group();
  fireEvent.click(section.getByText(t('settings.team.ownerTopics.edit')));
  const cost = section.getByRole('checkbox', { name: t('ownerTopics.builtIn.cost.label') });
  fireEvent.click(cost);
  await waitFor(() =>
    expect(project.backend.config.team.ownerDecisionTopics?.some(({ id }) => id === 'cost')).toBe(false),
  );
  const add = section.getByRole('button', { name: t('settings.team.ownerTopics.add') });
  await waitFor(() => expect(add.matches(':disabled')).toBe(false));
  fireEvent.click(add);
  expect(section.queryByRole('button', { name: t('settings.team.ownerTopics.add') })).toBeNull();
  expect(document.activeElement).toBe(section.getByLabelText(t('settings.team.ownerTopics.label')));
  fireEvent.change(section.getByLabelText(t('settings.team.ownerTopics.label')), {
    target: { value: 'Legal' },
  });
  fireEvent.change(section.getByLabelText(t('settings.team.ownerTopics.hint')), {
    target: { value: 'Contracts' },
  });
  fireEvent.click(section.getByRole('button', { name: t('settings.team.ownerTopics.submit') }));
  await waitFor(() =>
    expect(project.backend.config.team.ownerDecisionTopics?.at(-1)).toEqual({
      id: 'legal',
      label: 'Legal',
      hint: 'Contracts',
    }),
  );
  await waitFor(() => expect(document.activeElement).toBe(add));
  fireEvent.click(
    section.getByRole('button', { name: t('settings.team.ownerTopics.removeLabel', { label: 'Legal' }) }),
  );
  await waitFor(() =>
    expect(project.backend.config.team.ownerDecisionTopics?.some(({ id }) => id === 'legal')).toBe(false),
  );
  await waitFor(() => expect(document.activeElement).toBe(add));
});

it('focuses the first missing field without sending a patch', async () => {
  const project = mockProject();
  project.render(<SettingsTestRoutes initialSection="team" />);
  const section = await group();
  fireEvent.click(section.getByText(t('settings.team.ownerTopics.edit')));
  fireEvent.click(section.getByRole('button', { name: t('settings.team.ownerTopics.add') }));
  fireEvent.click(section.getByRole('button', { name: t('settings.team.ownerTopics.submit') }));
  expect(document.activeElement).toBe(section.getByLabelText(t('settings.team.ownerTopics.label')));
  expect(section.getByLabelText(t('settings.team.ownerTopics.hint')).getAttribute('aria-invalid')).toBe(
    'true',
  );
  expect(project.requests.some(({ method }) => method === 'PATCH')).toBe(false);
});

it('keeps input and shows a server issue beside the submitted field', async () => {
  const project = mockProject();
  const fetch = createMockFetch(project.backend, project.requests);
  setFetchImplementation(async (input, init) => {
    if (init?.method === 'PATCH')
      return new Response(
        JSON.stringify({
          error: {
            code: 'config_invalid',
            message: 'Invalid configuration',
            details: { issues: [{ code: 'too_small', path: 'team.ownerDecisionTopics.5.hint' }] },
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    return fetch(input, init);
  });
  project.render(<SettingsTestRoutes initialSection="team" />);
  const section = await group();
  fireEvent.click(section.getByText(t('settings.team.ownerTopics.edit')));
  fireEvent.click(section.getByRole('button', { name: t('settings.team.ownerTopics.add') }));
  fireEvent.change(section.getByLabelText(t('settings.team.ownerTopics.label')), {
    target: { value: 'Legal' },
  });
  fireEvent.change(section.getByLabelText(t('settings.team.ownerTopics.hint')), {
    target: { value: 'Contracts' },
  });
  fireEvent.click(section.getByRole('button', { name: t('settings.team.ownerTopics.submit') }));
  await waitFor(() =>
    expect(section.getByLabelText(t('settings.team.ownerTopics.hint')).getAttribute('aria-invalid')).toBe(
      'true',
    ),
  );
  expect((section.getByLabelText(t('settings.team.ownerTopics.label')) as HTMLInputElement).value).toBe(
    'Legal',
  );
  expect((section.getByLabelText(t('settings.team.ownerTopics.hint')) as HTMLTextAreaElement).value).toBe(
    'Contracts',
  );
});

it('shows the owner-only reading view to an administrator', async () => {
  const project = mockProject();
  project.render(<SettingsTestRoutes initialSection="team" />, '/', { isOwner: false });
  const section = await group();
  expect(section.queryByRole('checkbox')).toBeNull();
  expect(section.getByText(t('settings.team.ownerTopics.ownerOnly'))).toBeTruthy();
});

it('opens and focuses a topic field from a configuration problem link', async () => {
  const project = mockProject();
  project.backend.config.team.ownerDecisionTopics = [{ id: 'legal', label: 'Legal', hint: 'Contracts' }];
  project.render(
    <SettingsTestRoutes initialSection="team" />,
    '/p/AC/settings/team?field=ownerDecisionTopics.0.hint',
  );
  const section = await group();
  await waitFor(() => expect(document.activeElement).toBe(section.getByText('Contracts')));
  expect(section.getByText(t('settings.team.ownerTopics.edit')).parentElement?.hasAttribute('open')).toBe(
    true,
  );
});

it('warns when no topic is enabled', async () => {
  const project = mockProject();
  project.backend.config.team.ownerDecisionTopics = [];
  project.render(<SettingsTestRoutes initialSection="team" />);
  expect((await group()).getByRole('status').textContent).toBe(t('settings.team.ownerTopics.warning'));
});

it('disables additions at the limit while allowing removal', async () => {
  const project = mockProject();
  project.backend.config.team.ownerDecisionTopics = Array.from({ length: 12 }, (_, index) => ({
    id: `custom_${index}`,
    label: `Custom ${index}`,
    hint: 'Contracts',
  }));
  project.render(<SettingsTestRoutes initialSection="team" />);
  const section = await group();
  fireEvent.click(section.getByText(t('settings.team.ownerTopics.edit')));
  expect(section.getByRole('button', { name: t('settings.team.ownerTopics.add') }).matches(':disabled')).toBe(
    true,
  );
  expect(
    section.getByRole('checkbox', { name: t('ownerTopics.builtIn.cost.label') }).matches(':disabled'),
  ).toBe(true);
  expect(section.getAllByRole('button', { name: /Custom/ })[0]!.matches(':disabled')).toBe(false);
});

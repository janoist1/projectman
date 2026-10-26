import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { builtInRoles } from '../../mocks/fixtures';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { EditMemberDialog } from './EditMemberDialog';
import { MemberProfilePage } from './MemberProfilePage';
import { TeamPage } from './TeamPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
const dialog = (project: ReturnType<typeof mockProject>, handle = 'be-1', temp = false) =>
  project.render(
    <EditMemberDialog
      member={{ ...project.backend.findMember(handle)!, temp }}
      config={project.backend.config}
      roles={builtInRoles}
      onClose={() => {}}
    />,
  );
const patches = (project: ReturnType<typeof mockProject>) =>
  project.requests.filter((request) => request.method === 'PATCH');

describe('developer complexity limits', () => {
  it('shows effective and default limits in the roster', async () => {
    const project = mockProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/be-1', { complexityLimit: 13 });
    project.render(<TeamPage />);
    const chip = (await screen.findAllByText(t('team.limit', { limit: 13 })))[0]!;
    expect(chip.closest('[title]')?.getAttribute('title')).toBe(t('team.limitUnlimited'));
    expect(screen.getAllByText(t('team.limit', { limit: 5 })).length).toBeGreaterThan(0);
  });
  it('shows the effective limit in a developer profile', async () => {
    const project = mockProject();
    project.render(
      <Routes>
        <Route path="/team/:handle" element={<MemberProfilePage />} />
      </Routes>,
      '/team/be-1',
    );
    expect(await screen.findByText(t('team.limit', { limit: 5 }))).toBeTruthy();
  });
  it('selects the default and sends a chosen limit', async () => {
    const project = mockProject();
    dialog(project);
    const select = screen.getByLabelText(t('memberEdit.limit')) as HTMLSelectElement;
    expect(select.value).toBe('5');
    fireEvent.change(select, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(project.backend.findMember('be-1')?.complexityLimit).toBe(3));
    expect(patches(project).at(-1)?.body).toMatchObject({ complexityLimit: 3 });
  });
  it('sends null for the default', async () => {
    const project = mockProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/be-1', { complexityLimit: 13 });
    dialog(project);
    fireEvent.change(screen.getByLabelText(t('memberEdit.limit')), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(patches(project).at(-1)?.body).toMatchObject({ complexityLimit: null }));
    expect(project.backend.findMember('be-1')?.complexityLimit).toBe(5);
  });
  it.each(['owner', 'qa'])('hides the field for %s', (handle) => {
    const project = mockProject();
    dialog(project, handle);
    expect(screen.queryByLabelText(t('memberEdit.limit'))).toBeNull();
  });
  it('explains the fixed temp limit without an editable field', () => {
    const project = mockProject();
    dialog(project, 'be-1', true);
    expect(screen.queryByLabelText(t('memberEdit.limit'))).toBeNull();
    expect(screen.getByText(t('memberEdit.tempLimit'))).toBeTruthy();
  });
  it('keeps the dialog and choice on a server refusal', async () => {
    const project = mockProject();
    const fetch = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (path, init) =>
      init?.method === 'PATCH'
        ? new Response(JSON.stringify({ error: { code: 'complexity_limit_not_developer', message: 'No' } }), {
            status: 422,
          })
        : fetch(path, init),
    );
    dialog(project);
    fireEvent.change(screen.getByLabelText(t('memberEdit.limit')), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText(t('memberEdit.limit')) as HTMLSelectElement).value).toBe('8');
  });
});

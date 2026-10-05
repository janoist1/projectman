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

const dialog = (project: ReturnType<typeof mockProject>, handle: string, temp = false) => {
  const member = project.backend.findMember(handle)!;
  return project.render(
    <EditMemberDialog
      member={temp ? { ...member, temp: true } : member}
      config={project.backend.config}
      roles={builtInRoles}
      onClose={() => {}}
    />,
  );
};
const patches = (project: ReturnType<typeof mockProject>) =>
  project.requests.filter((request) => request.method === 'PATCH');

describe('the Senior developer in the team (PM-349)', () => {
  it('shows a Senior chip in the roster for the Senior only', async () => {
    const project = mockProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/be-1', { senior: true });
    project.render(<TeamPage />);
    const chips = await screen.findAllByText(t('team.senior'));
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0]!.closest('[title]')?.getAttribute('title')).toBe(t('team.seniorTitle'));
    // Every chip sits on the Senior's own row or card.
    for (const chip of chips)
      expect(chip.closest('tr, li, article')?.textContent).toContain('Backend fejlesztő');
  });

  it('shows no Senior chip while nobody is Senior', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    await screen.findAllByText('Backend fejlesztő');
    expect(screen.queryByText(t('team.senior'))).toBeNull();
  });

  it('shows the chip in the profile header of the Senior', async () => {
    const project = mockProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/be-1', { senior: true });
    project.render(
      <Routes>
        <Route path="/team/:handle" element={<MemberProfilePage />} />
      </Routes>,
      '/team/be-1',
    );
    expect(await screen.findByText(t('team.senior'))).toBeTruthy();
  });

  it('has no chip in the profile of a member who is no Senior', async () => {
    const project = mockProject();
    project.render(
      <Routes>
        <Route path="/team/:handle" element={<MemberProfilePage />} />
      </Routes>,
      '/team/be-1',
    );
    await screen.findByRole('banner');
    expect(screen.queryByText(t('team.senior'))).toBeNull();
  });
});

describe('the "Senior fejlesztő" box of the member form (PM-349)', () => {
  it('is off for an ordinary developer, explains itself, and sends the choice with the form', async () => {
    const project = mockProject();
    dialog(project, 'be-1');
    const box = screen.getByLabelText(t('memberEdit.senior')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(t('memberEdit.seniorHint'))).toBeTruthy();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(project.backend.findMember('be-1')?.senior).toBe(true));
    expect(patches(project).at(-1)?.body).toMatchObject({ senior: true });
  });

  it('is on for the Senior, and turning it off sends false', async () => {
    const project = mockProject();
    project.backend.handle('PATCH', '/api/projects/AC/members/be-1', { senior: true });
    dialog(project, 'be-1');
    const box = screen.getByLabelText(t('memberEdit.senior')) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(project.backend.findMember('be-1')?.senior).toBeFalsy());
    expect(patches(project).at(-1)?.body).toMatchObject({ senior: false });
  });

  it('is left out of the request when it did not change', async () => {
    const project = mockProject();
    dialog(project, 'be-1');
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    expect(patches(project)[0]!.body).not.toHaveProperty('senior');
  });

  it('is not offered to a human member or to a stand-in', async () => {
    const human = mockProject();
    dialog(human, 'owner');
    await screen.findByText(t('memberEdit.roles'));
    expect(screen.queryByLabelText(t('memberEdit.senior'))).toBeNull();
  });

  it('is not offered to a stand-in', () => {
    const project = mockProject();
    dialog(project, 'be-1', true);
    expect(screen.queryByLabelText(t('memberEdit.senior'))).toBeNull();
  });

  it('shows the refusal of the server in the dialog', async () => {
    const project = mockProject();
    const fetch = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (path, init) => {
      if (init?.method === 'PATCH')
        return new Response(JSON.stringify({ error: { code: 'senior_not_allowed', message: 'No' } }), {
          status: 400,
        });
      return fetch(path, init);
    });
    dialog(project, 'be-1');
    fireEvent.click(screen.getByLabelText(t('memberEdit.senior')));
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    expect((await screen.findByRole('alert')).textContent).toBe(t('errors.codes.senior_not_allowed'));
  });
});

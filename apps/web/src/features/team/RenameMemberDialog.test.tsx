import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useParams } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { MemberProfilePage } from './MemberProfilePage';
import { RenameMemberDialog } from './RenameMemberDialog';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function Landed() {
  const { handle } = useParams();
  return <output data-testid="landed">{handle}</output>;
}

/** The fixture's qa has a running session, which refuses a rename; this ends it. */
function endSessions(project: ReturnType<typeof mockProject>, handle: string) {
  for (const session of project.backend.sessions) if (session.member === handle) session.state = 'exited';
}

function setup({ working = false }: { working?: boolean } = {}) {
  const project = mockProject();
  if (!working) endSessions(project, 'qa');
  project.render(
    <Routes>
      <Route
        path="/team/qa"
        element={<RenameMemberDialog member={project.backend.findMember('qa')!} onClose={() => {}} />}
      />
      <Route path="/p/AC/team/:handle" element={<Landed />} />
    </Routes>,
    '/team/qa',
  );
  return project;
}

const field = () => screen.findByLabelText(t('memberRename.label'));
const submit = () => fireEvent.click(screen.getByRole('button', { name: t('memberRename.submit') }));
const renameRequests = (project: ReturnType<typeof setup>) =>
  project.requests.filter((request) => request.path.endsWith('/rename'));

describe('RenameMemberDialog (PM-1026)', () => {
  it('sends the lower-cased handle and moves to the new profile', async () => {
    const project = setup();
    fireEvent.change(await field(), { target: { value: ' Tester ' } });
    submit();
    expect((await screen.findByTestId('landed')).textContent).toBe('tester');
    expect(renameRequests(project)[0]).toMatchObject({ method: 'POST', body: { handle: 'tester' } });
    expect(project.backend.findMember('tester')?.formerHandles).toEqual(['qa']);
  });

  it('refuses a malformed or unchanged handle without asking the server', async () => {
    const project = setup();
    fireEvent.change(await field(), { target: { value: '-bad' } });
    submit();
    expect(await screen.findByText(t('memberRename.invalid'))).toBeTruthy();
    fireEvent.change(await field(), { target: { value: 'qa' } });
    submit();
    expect(await screen.findByText(t('memberRename.unchanged'))).toBeTruthy();
    expect(renameRequests(project)).toHaveLength(0);
  });

  it('shows a taken handle at the field', async () => {
    setup();
    fireEvent.change(await field(), { target: { value: 'fe-1' } });
    submit();
    expect(await screen.findByText(t('memberRename.taken', { handle: 'fe-1' }))).toBeTruthy();
  });

  it('shows a refusal because of running work as an alert and keeps the typed value', async () => {
    setup({ working: true });
    fireEvent.change(await field(), { target: { value: 'tester' } });
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('errors.memberSessionLiveReason.session'));
    expect((await field()) as HTMLInputElement).toHaveProperty('value', 'tester');
  });

  it('names the mailbox address the member will have when its e-mail is on', async () => {
    const project = mockProject();
    endSessions(project, 'qa');
    const config = project.backend.config.team.members.find((member) => member.handle === 'qa')!;
    if (config.kind !== 'ai') throw new Error('Expected AI fixture');
    config.email = { enabled: true };
    project.render(
      <RenameMemberDialog member={project.backend.findMember('qa')!} onClose={() => {}} />,
      '/team/qa',
    );
    fireEvent.change(await field(), { target: { value: 'tester' } });
    await waitFor(() => expect(screen.getByText(/tester@mail\.example\.com/)).toBeTruthy());
  });
});

describe('the member profile after a rename (PM-1026)', () => {
  const page = (
    <Routes>
      <Route path="/p/AC/team/:handle" element={<MemberProfilePage />} />
    </Routes>
  );

  it.each([
    ['qa', true],
    ['kata', false],
  ])('offers the rename of %s: %s (owner, AI member only)', async (handle, offered) => {
    const project = mockProject();
    project.render(page, `/p/AC/team/${handle}`);
    const { displayName } = project.backend.findMember(handle)!;
    fireEvent.click(await screen.findByRole('button', { name: t('team.moreFor', { name: displayName }) }));
    const row = screen.queryByRole('button', { name: t('memberRename.menuFor', { name: displayName }) });
    expect(row !== null).toBe(offered);
  });

  it('sends the old address of a renamed member to the new one and shows the old handle', async () => {
    const project = mockProject();
    endSessions(project, 'qa');
    const renamed = project.backend.findMember('qa')!;
    project.backend.handle('POST', '/api/projects/AC/members/qa/rename', { handle: 'tester' });
    project.render(page, '/p/AC/team/qa');
    expect(await screen.findByRole('heading', { level: 1, name: renamed.displayName })).toBeTruthy();
    const former = await screen.findByText('qa', { selector: 'code' });
    expect(former.closest('span')?.textContent).toContain(t('memberRename.former'));
    expect(project.requests.some((request) => request.path.includes('/members/qa/profile'))).toBe(false);
  });
});

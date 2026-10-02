import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { getLocale } from '@projectman/templates';
import { setFetchImplementation } from '../../api/client';
import { formatTokens as format } from '../../i18n/format';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { MemberProfilePage } from './MemberProfilePage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
/** A count as the queries see it: their normalizer turns the grouping (no-break) spaces into plain ones. */
const formatTokens = (count: number) => format(count).replace(/\s/g, ' ');
function page() {
  return (
    <Routes>
      <Route path="/team/:handle" element={<MemberProfilePage />} />
      <Route path="/p/AC/team" element={<p>{t('team.title')}</p>} />
      <Route path="/p/AC/sessions/:id" element={<p>{t('profile.openSession')}</p>} />
    </Routes>
  );
}
/** Opens the "⋯" menu of the profile and picks an entry. */
async function chooseFromMenu(p: ReturnType<typeof mockProject>, handle: string, name: string) {
  const member = p.backend.findMember(handle)!;
  fireEvent.click(
    await screen.findByRole('button', { name: t('team.moreFor', { name: member.displayName }) }),
  );
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('member profiles', () => {
  it('has one main button, the rest sits in the menu', async () => {
    const p = mockProject();
    p.render(page(), '/team/fe-1');
    const header = within(await screen.findByRole('banner'));
    const name = p.backend.findMember('fe-1')!.displayName;
    expect(
      header.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual([t('profile.conversation'), t('team.moreFor', { name })]);
    fireEvent.click(header.getByRole('button', { name: t('team.moreFor', { name }) }));
    expect(header.getByRole('button', { name: t('memberEdit.editMember', { name }) })).toBeTruthy();
    expect(header.getByRole('button', { name: t('leave.sendMember', { name }) })).toBeTruthy();
    expect(
      header.getByRole('button', { name: t('team.retireMember', { name, handle: 'fe-1' }) }),
    ).toBeTruthy();
  });

  it('marks a member on leave next to the name', async () => {
    const p = mockProject();
    p.backend.findMember('fe-1')!.onLeave = true;
    p.render(page(), '/team/fe-1');
    const header = within(await screen.findByRole('banner'));
    expect(await header.findByText(t('leave.onLeave'))).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(t('leave.status'));
    expect(header.getByRole('button', { name: t('profile.conversation') }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('lists the duties as chips and puts the empty things in one quiet line, not in boxes', async () => {
    const p = mockProject();
    p.backend.sessions = [];
    p.backend.tasks = [];
    p.backend.memories['fe-1'] = '';
    p.render(page(), '/team/fe-1');
    await screen.findByRole('heading', { name: t('profile.duties') });
    const duty = screen.getByText(t('dutyNames.implementation'));
    expect(duty.closest('li')?.parentElement?.tagName).toBe('UL');
    await waitFor(() => expect(screen.getByText(new RegExp(t('profile.memoryEmpty')))).toBeTruthy());
    const quiet = screen.getByText(new RegExp(t('profile.noTasks')));
    expect(quiet.textContent).toContain(t('profile.noSessions'));
    expect(quiet.textContent).toContain(t('profile.memoryEmpty'));
    expect(quiet.closest('section')).toBeNull();
    for (const title of ['profile.tasks', 'profile.live', 'profile.sessions', 'profile.memory'] as const)
      expect(screen.queryByRole('heading', { name: t(title) })).toBeNull();
  });

  it('says a human has no decision waiting without a panel', async () => {
    const p = mockProject();
    p.render(page(), '/team/bence');
    await screen.findByRole('heading', { name: 'Bence' });
    expect(screen.getByText(new RegExp(t('profile.noWaiting'))).closest('section')).toBeNull();
    expect(screen.queryByRole('heading', { name: t('profile.waiting') })).toBeNull();
  });

  it('creates a seat invitation from an unclaimed human profile and displays the link', async () => {
    const p = mockProject();
    p.backend.handle('POST', '/api/projects/AC/members/human', {
      displayName: 'Fictional Colleague',
      handle: 'colleague',
      access: 'viewer',
      roles: [],
    });
    p.render(page(), '/team/colleague');
    expect(await screen.findByText(t('memberStatus.no_account'))).toBeTruthy();
    await chooseFromMenu(p, 'colleague', t('invites.create'));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(t('invites.email')), { target: { value: 'colleague@acme.test' } });
    fireEvent.click(await dialog.findByRole('button', { name: t('invites.create') }));
    expect(((await dialog.findByLabelText(t('invites.link'))) as HTMLInputElement).value).toContain(
      '/invite/',
    );
    expect(
      p.requests.find((request) => request.method === 'POST' && request.path.endsWith('/invites'))?.body,
    ).toEqual({ email: 'colleague@acme.test', memberHandle: 'colleague', access: 'viewer', roles: [] });
  });

  it.each([
    ['claude-opus-5-5', t('providerSettings.claudeModels.opus55')],
    ['claude-fictional-model', 'claude-fictional-model'],
  ])('shows Claude model %s and effort', async (model, label) => {
    const p = mockProject();
    p.backend.handle('PATCH', '/api/projects/AC/members/fe-1', { model, effort: 'max' });
    p.render(page(), '/team/fe-1');
    expect(await screen.findByText(`${label} · ${t('providerSettings.efforts.max')}`)).toBeTruthy();
  });

  it('shows AI settings, current work, live chat, sessions, memory, schedule and thread composer', async () => {
    const p = mockProject();
    p.backend.memories['fe-1'] = 'Acme uses fictional checkout fixtures.';
    p.render(page(), '/team/fe-1');
    expect(
      await screen.findByRole('heading', { name: p.backend.findMember('fe-1')!.displayName }),
    ).toBeTruthy();
    expect(await screen.findByText('Acme uses fictional checkout fixtures.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: t('profile.live') })).toBeTruthy();
    expect(screen.getByRole('heading', { name: t('profile.tasks') })).toBeTruthy();
    expect(screen.getByRole('heading', { name: t('schedules.form.title') })).toBeTruthy();
    expect(screen.getByRole('heading', { name: t('profile.activity') })).toBeTruthy();
    expect(screen.getByRole('heading', { name: t('profile.thread') })).toBeTruthy();
    expect(screen.getByLabelText(t('messages.text'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('profile.conversation') })).toBeTruthy();
    expect(screen.getByText(t('dutyNames.implementation'))).toBeTruthy();
  });
  it('shows the tokens of the last day and the last week (PM-178)', async () => {
    const p = mockProject();
    p.render(page(), '/team/fe-1');
    const heading = await screen.findByRole('heading', { name: t('tokenUsage.title') });
    const panel = heading.parentElement!;
    expect(within(panel).getByRole('heading', { name: t('tokenUsage.lastDay') })).toBeTruthy();
    expect(within(panel).getByRole('heading', { name: t('tokenUsage.lastWeek') })).toBeTruthy();
    expect(
      within(panel).getAllByText(t('tokenUsage.total', { total: formatTokens(2_427_700) })),
    ).toHaveLength(2);
  });

  it('shows no tokens for a member whose sessions used none in the windows', async () => {
    const p = mockProject();
    p.render(page(), '/team/qa');
    const heading = await screen.findByRole('heading', { name: t('tokenUsage.title') });
    expect(within(heading.parentElement!).getAllByText(t('tokenUsage.none'))).toHaveLength(2);
  });

  it('shows what each role of the member does, does not do, and when to turn to them', async () => {
    const p = mockProject();
    const qa = getLocale('hu').roles.qa;
    p.render(page(), '/team/qa');
    const role = within(await screen.findByRole('generic', { name: qa.name }));
    expect(role.getByText(qa.summary)).toBeTruthy();
    expect(role.getByText(`${t('roleCatalogue.notTheirJob')}: ${qa.notTheirJob}`)).toBeTruthy();
    expect(role.getByText(`${t('roleCatalogue.whenToAsk')}: ${qa.whenToAsk}`)).toBeTruthy();
  });
  it('shows the instructions of the role and the own ones, and edits the own ones from the profile', async () => {
    const p = mockProject();
    const member = p.backend.config.team.members.find((m) => m.handle === 'fe-1')!;
    if (member.kind !== 'ai') throw new Error('Expected fictional AI member');
    member.instructions = 'Work in your own worktree.';
    p.render(page(), '/team/fe-1');
    const panel = within(await screen.findByLabelText(t('profile.instructions')));
    expect(panel.getByText('Work in your own worktree.')).toBeTruthy();
    expect(panel.getByRole('link', { name: t('profile.roleInstructionsEdit') })).toBeTruthy();
    await chooseFromMenu(
      p,
      'fe-1',
      t('memberEdit.editMember', { name: p.backend.findMember('fe-1')!.displayName }),
    );
    const dialog = within(screen.getByRole('dialog'));
    const field = dialog.getByLabelText(t('memberEdit.instructions')) as HTMLTextAreaElement;
    expect(field.value).toBe('Work in your own worktree.');
    fireEvent.change(field, { target: { value: 'Always attach screenshots.' } });
    fireEvent.click(dialog.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(member.instructions).toBe('Always attach screenshots.'));
    expect(p.requests.filter((request) => request.method === 'PATCH').at(-1)?.body).toMatchObject({
      instructions: 'Always attach screenshots.',
    });
    expect(await screen.findByText('Always attach screenshots.')).toBeTruthy();
  });
  it('starts a general conversation and opens the session', async () => {
    const p = mockProject();
    p.backend.sessions = [];
    p.backend.tasks = [];
    p.backend.planUsage.weeklyPercent = 0;
    p.render(page(), '/team/fe-1');
    fireEvent.click(await screen.findByRole('button', { name: t('profile.conversation') }));
    await screen.findByText(t('profile.openSession'));
    expect(p.backend.sessions[0]?.workItem).toEqual({ type: 'general' });
  });
  it('shows human access and decisions with email and access editing for admins', async () => {
    const p = mockProject();
    p.render(page(), '/team/bence');
    expect(await screen.findByRole('heading', { name: 'Bence' })).toBeTruthy();
    expect(screen.getByText('bence@acme.test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('profile.conversation') })).toBeNull();
    await chooseFromMenu(p, 'bence', t('memberEdit.editMember', { name: 'Bence' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(t('invites.access')), { target: { value: 'client' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(p.backend.findMember('bence')?.role).toBe('client'));
  });
  it('shows the next scheduled run and runs it from the profile', async () => {
    const p = mockProject();
    p.backend.sessions = [];
    p.backend.tasks = [];
    p.backend.planUsage.fiveHourPercent = 0;
    p.backend.planUsage.weeklyPercent = 0;
    const member = p.backend.config.team.members.find((m) => m.handle === 'fe-1')!;
    if (member.kind !== 'ai') throw new Error('Expected fictional AI member');
    member.schedule = { cron: '0 9 * * *', prompt: 'Inspect fictional Acme fixtures.' };
    p.render(page(), '/team/fe-1');
    expect(await screen.findByText('minden nap reggel 9')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: t('schedules.runNow') }));
    await waitFor(() => expect(p.backend.scheduleRuns[0]?.status).toBe('started'));
    expect(p.requests.some((r) => r.method === 'POST' && r.path.endsWith('/schedule/run'))).toBe(true);
  });
  it('offers human removal with an explicit confirmation and keeps it restricted to admins', async () => {
    const p = mockProject();
    p.render(page(), '/team/bence');
    await chooseFromMenu(p, 'bence', t('profile.remove'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(t('profile.removeConfirm', { name: 'Bence' }))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: t('profile.remove') }));
    await waitFor(() => expect(p.backend.findMember('bence')).toBeUndefined());
    expect(p.requests.some((r) => r.method === 'DELETE' && r.path.endsWith('/bence/remove'))).toBe(true);
  });
  it('hides email and administrative actions from non-admin members', async () => {
    const p = mockProject();
    p.backend.viewerHandle = 'bence';
    p.render(page(), '/team/kata', { can: { createTasks: true, manageTeam: false, workInSessions: true } });
    await screen.findByRole('heading', { name: 'Kata' });
    expect(screen.queryByText('kata@acme.test')).toBeNull();
    expect(screen.queryByRole('button', { name: t('memberEdit.edit') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('profile.remove') })).toBeNull();
  });
});

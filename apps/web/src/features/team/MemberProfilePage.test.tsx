import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { MemberProfilePage } from './MemberProfilePage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
function page() {
  return (
    <Routes>
      <Route path="/team/:handle" element={<MemberProfilePage />} />
      <Route path="/p/AC/team" element={<p>{t('team.title')}</p>} />
      <Route path="/p/AC/sessions/:id" element={<p>{t('profile.openSession')}</p>} />
    </Routes>
  );
}
describe('member profiles', () => {
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
    fireEvent.click(screen.getByRole('button', { name: t('invites.create') }));
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
    expect(screen.getByRole('heading', { name: t('profile.waiting') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('profile.conversation') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.edit') }));
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
    expect(await screen.findByText('0 9 * * *')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: t('schedules.runNow') }));
    await waitFor(() => expect(p.backend.scheduleRuns[0]?.status).toBe('started'));
    expect(p.requests.some((r) => r.method === 'POST' && r.path.endsWith('/schedule/run'))).toBe(true);
  });
  it('offers human removal with an explicit confirmation and keeps it restricted to admins', async () => {
    const p = mockProject();
    p.render(page(), '/team/bence');
    fireEvent.click(await screen.findByRole('button', { name: t('profile.remove') }));
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

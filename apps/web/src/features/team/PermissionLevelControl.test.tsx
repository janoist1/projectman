import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import type { PermissionMode } from '@projectman/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectContextValue } from '../../app/contexts';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { TeamSection } from '../settings/sections/TeamSection';
import { MemberProfilePage } from './MemberProfilePage';
import { TeamPage } from './TeamPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const level = (name: 'auto' | 'ask_ai' | 'ask_human' | 'plan') => t(`permissionLevels.levels.${name}`);
const asAdmin: Partial<ProjectContextValue> = { isOwner: false };
/** A member from before the level existed: only the historical mode is stored. */
function setHistoricalMode(project: ReturnType<typeof mockProject>, handle: string, mode: PermissionMode) {
  const member = project.backend.config.team.members.find((m) => m.handle === handle);
  if (member?.kind !== 'ai') throw new Error(`no AI member ${handle}`);
  member.permissionMode = mode;
  delete member.permissionLevel;
  project.backend.syncPermissionViews();
}
const patches = (project: ReturnType<typeof mockProject>, handle: string) =>
  project.requests.filter((r) => r.method === 'PATCH' && r.path.endsWith(`/members/${handle}`));

/** The settings row of a member, found by its handle, once the roster (and so its level) has loaded. */
async function settingsRow(project: ReturnType<typeof mockProject>, handle: string) {
  project.render(<TeamSection config={project.backend.config} />);
  const row = (await screen.findByText(handle, { selector: 'code' })).closest('tr')!;
  await within(row).findByLabelText(t('permissionLevels.title'));
  return row;
}

describe('the permission level in Settings → Team', () => {
  it('shows the derived level of members from before the level existed', async () => {
    const project = mockProject();
    setHistoricalMode(project, 'devops', 'auto');
    // `code-review` is on the historical "plan" mode, `qa` on "default".
    await settingsRow(project, 'qa');
    const select = async (handle: string) =>
      within((await screen.findByText(handle, { selector: 'code' })).closest('tr')!).getByLabelText(
        t('permissionLevels.title'),
      ) as HTMLSelectElement;
    expect((await select('devops')).value).toBe('auto');
    expect((await select('code-review')).value).toBe('plan');
    expect((await select('qa')).value).toBe('ask_human');
  });

  it('lets an owner set the level, saved at once through the member route', async () => {
    const project = mockProject();
    const row = within(await settingsRow(project, 'qa'));
    fireEvent.change(row.getByLabelText(t('permissionLevels.title')), { target: { value: 'plan' } });
    await waitFor(() => expect(patches(project, 'qa')).toHaveLength(1));
    expect(patches(project, 'qa')[0]!.body).toEqual({ permissionLevel: 'plan' });
    expect(project.requests.some((r) => r.method === 'PATCH' && r.path.endsWith('/config'))).toBe(false);
    await waitFor(() =>
      expect((row.getByLabelText(t('permissionLevels.title')) as HTMLSelectElement).value).toBe('plan'),
    );
    expect(project.backend.config.team.members.find((m) => m.handle === 'qa')).toMatchObject({
      permissionLevel: 'plan',
    });
  });

  it('shows everyone else the level without a control', async () => {
    const project = mockProject();
    project.render(<TeamSection config={project.backend.config} />, '/', asAdmin);
    const row = within((await screen.findByText('code-review', { selector: 'code' })).closest('tr')!);
    expect(await row.findByText(level('plan'))).toBeTruthy();
    expect(screen.queryAllByLabelText(t('permissionLevels.title'))).toHaveLength(0);
  });

  it('disables "ask, AI decides" and says why while delegation is off', async () => {
    const project = mockProject();
    const row = within(await settingsRow(project, 'qa'));
    const option = row.getByRole('option', { name: level('ask_ai') }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(row.getByText(t('permissionLevels.blocked.delegation_off'))).toBeTruthy();
    expect((row.getByRole('option', { name: level('plan') }) as HTMLOptionElement).disabled).toBe(false);
  });

  it('says there is no decider while delegation is on but no AI member holds the duty', async () => {
    const project = mockProject();
    project.backend.config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
    project.backend.syncPermissionViews();
    const row = within(await settingsRow(project, 'qa'));
    expect((row.getByRole('option', { name: level('ask_ai') }) as HTMLOptionElement).disabled).toBe(true);
    expect(row.getByText(t('permissionLevels.blocked.no_ai_decider'))).toBeTruthy();
  });

  it('enables "ask, AI decides" once delegation is on and an AI member can decide, and saves it', async () => {
    const project = mockProject();
    project.backend.config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
    const lead = project.backend.config.team.members.find((m) => m.handle === 'code-review')!;
    if (lead.kind === 'ai') lead.role = 'lead_developer';
    project.backend.syncPermissionViews();
    const row = within(await settingsRow(project, 'qa'));
    expect((row.getByRole('option', { name: level('ask_ai') }) as HTMLOptionElement).disabled).toBe(false);
    fireEvent.change(row.getByLabelText(t('permissionLevels.title')), { target: { value: 'ask_ai' } });
    await waitFor(() => expect(patches(project, 'qa')).toHaveLength(1));
    expect(patches(project, 'qa')[0]!.body).toEqual({ permissionLevel: 'ask_ai' });
    await waitFor(() =>
      expect((row.getByLabelText(t('permissionLevels.title')) as HTMLSelectElement).value).toBe('ask_ai'),
    );
  });

  it('shows a legacy "everything allowed" member with the old-setting mark, and no such choice', async () => {
    const project = mockProject();
    setHistoricalMode(project, 'qa', 'bypassPermissions');
    const row = within(await settingsRow(project, 'qa'));
    expect(row.getByText(t('permissionLevels.legacy'))).toBeTruthy();
    expect(row.queryByRole('option', { name: t('permissionModes.bypassPermissions') })).toBeNull();
    expect(row.getAllByRole('option')).toHaveLength(5);
  });
});

describe('the permission level in the member profile', () => {
  const page = () => (
    <Routes>
      <Route path="/team/:handle" element={<MemberProfilePage />} />
    </Routes>
  );

  it('is set from the profile by an owner', async () => {
    const project = mockProject();
    project.render(page(), '/team/fe-1');
    const select = (await screen.findByLabelText(t('permissionLevels.title'))) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'ask_human' } });
    await waitFor(() => expect(patches(project, 'fe-1')).toHaveLength(1));
    expect(patches(project, 'fe-1')[0]!.body).toEqual({ permissionLevel: 'ask_human' });
  });

  it('shows no control to anyone else', async () => {
    const project = mockProject();
    project.render(page(), '/team/fe-1', asAdmin);
    await screen.findAllByText(t('permissionLevels.title'));
    expect(screen.queryAllByLabelText(t('permissionLevels.title'))).toHaveLength(0);
  });
});

describe('the server rules in the fake backend', () => {
  const patch = (project: ReturnType<typeof mockProject>, body: unknown) =>
    project.backend.handle('PATCH', '/api/projects/AC/members/qa', body);

  it('refuses an admin, and a level that cannot be chosen', () => {
    const project = mockProject();
    const owner = project.backend.config.team.members.find(
      (m) => m.kind === 'human' && m.handle === 'owner',
    )!;
    expect(patch(project, { permissionLevel: 'ask_ai' })).toMatchObject({
      status: 422,
      body: { error: { code: 'permission_level_unavailable', details: { blocker: 'delegation_off' } } },
    });
    if (owner.kind === 'human') owner.access = 'admin';
    expect(patch(project, { permissionLevel: 'plan' })).toMatchObject({
      status: 403,
      body: { error: { code: 'owner_only' } },
    });
  });

  it('is refused for a human member', () => {
    const project = mockProject();
    expect(
      project.backend.handle('PATCH', '/api/projects/AC/members/owner', { permissionLevel: 'plan' }),
    ).toMatchObject({ status: 400, body: { error: { code: 'not_ai_member' } } });
  });
});

describe('the Team page when the AI decider drops out', () => {
  it('warns about the members still set to "ask, AI decides"', async () => {
    const project = mockProject();
    const qa = project.backend.config.team.members.find((m) => m.handle === 'qa')!;
    if (qa.kind === 'ai') qa.permissionLevel = 'ask_ai';
    project.backend.syncPermissionViews();
    project.render(<TeamPage />);
    const warning = await screen.findByRole('status', { name: t('permissionLevels.lostDeciderLabel') });
    const name = project.backend.members.find((m) => m.handle === 'qa')!.displayName;
    expect(warning.textContent).toBe(t('permissionLevels.lostDecider', { names: name }));
  });

  it('shows no warning when nobody relies on an AI decider', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    await screen.findByRole('region', { name: t('team.roster') });
    expect(screen.queryByRole('status', { name: t('permissionLevels.lostDeciderLabel') })).toBeNull();
  });
});

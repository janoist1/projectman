import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { SessionPage } from './SessionPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const sessionRoute = (
  <Routes>
    <Route path="/sessions/:sessionId" element={<SessionPage />} />
  </Routes>
);
const SESSION = 'ses_ac21_fe1';
const modeSelect = () => screen.getByLabelText(t('session.permissions.mode')) as HTMLSelectElement;
const approverSelect = () => screen.getByLabelText(t('session.permissions.approver')) as HTMLSelectElement;
const patches = (project: ReturnType<typeof mockProject>) =>
  project.requests.filter((r) => r.method === 'PATCH' && r.path.endsWith(`/sessions/${SESSION}`));
const memberMode = (project: ReturnType<typeof mockProject>) => {
  const member = project.backend.config.team.members.find((m) => m.handle === 'fe-1');
  return member?.kind === 'ai' ? member.permissionMode : undefined;
};

describe('the permission settings in the session header (PM-170)', () => {
  it('gives an owner both selectors with the member’s values, naming them in the list', async () => {
    const project = mockProject();
    project.render(sessionRoute, `/sessions/${SESSION}`);
    await screen.findByLabelText(t('session.permissions.mode'));
    expect(modeSelect().value).toBe('acceptEdits');
    expect(approverSelect().value).toBe('human');
    const memberOption = [...modeSelect().options].find((o) => o.value === 'acceptEdits')!;
    expect(memberOption.textContent).toBe(
      t('session.permissions.memberValue', { value: t('permissionModes.acceptEdits') }),
    );
    expect([...modeSelect().options].map((o) => o.value)).not.toContain('bypassPermissions');
    expect(screen.queryByRole('button', { name: t('session.permissions.reset') })).toBeNull();
  });

  it('sets the mode for this session only; it applies from the next turn of a busy session', async () => {
    const project = mockProject();
    project.render(sessionRoute, `/sessions/${SESSION}`);
    await screen.findByLabelText(t('session.permissions.mode'));
    fireEvent.change(modeSelect(), { target: { value: 'plan' } });
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    expect(patches(project)[0]!.body).toEqual({ permissionMode: 'plan' });
    await waitFor(() => expect(modeSelect().value).toBe('plan'));
    expect(await screen.findByText(t('session.permissions.restartPending'))).toBeTruthy();
    expect(memberMode(project)).toBe('acceptEdits');
    expect(project.requests.some((r) => r.method === 'PATCH' && r.path.includes('/members/'))).toBe(false);
  });

  it('sets who answers at once, and goes back to the member’s settings', async () => {
    const project = mockProject();
    project.render(sessionRoute, `/sessions/${SESSION}`);
    await screen.findByLabelText(t('session.permissions.approver'));
    fireEvent.change(approverSelect(), { target: { value: 'none' } });
    await waitFor(() => expect(approverSelect().value).toBe('none'));
    expect(patches(project)[0]!.body).toEqual({ approver: 'none' });
    expect(screen.queryByText(t('session.permissions.restartPending'))).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: t('session.permissions.reset') }));
    await waitFor(() => expect(approverSelect().value).toBe('human'));
    expect(patches(project)[1]!.body).toEqual({ approver: null });
    expect(screen.queryByRole('button', { name: t('session.permissions.reset') })).toBeNull();
  });

  it('keeps the AI approver disabled, with the reason, while it cannot be chosen', async () => {
    const project = mockProject();
    project.render(sessionRoute, `/sessions/${SESSION}`);
    await screen.findByLabelText(t('session.permissions.approver'));
    const ai = [...approverSelect().options].find((o) => o.value === 'ai')!;
    expect(ai.disabled).toBe(true);
    expect(screen.getByText(t('permissionControls.blocked.delegation_off'))).toBeTruthy();
  });

  it('shows everyone else what applies, marked when it is the session’s own, and no selectors', async () => {
    const project = mockProject();
    Object.assign(project.backend.findSession(SESSION)!, {
      permissionModeOverride: 'plan',
      permissionGrantsLost: true,
    });
    project.render(sessionRoute, `/sessions/${SESSION}`, { isOwner: false });
    const own = t('session.chips.sessionOwn');
    expect(
      await screen.findByText(
        `${t('session.chips.permissions', { mode: t('permissionModes.plan') })} · ${own}`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(t('session.chips.approver', { approver: t('permissionControls.approvers.human') })),
    ).toBeTruthy();
    expect(screen.getByText(t('session.permissions.grantsLost'))).toBeTruthy();
    expect(screen.queryByLabelText(t('session.permissions.mode'))).toBeNull();
  });

  it('is refused for a viewer who is not an owner, as on the server', () => {
    const project = mockProject();
    project.backend.findMember('owner')!.role = 'admin';
    const refused = project.backend.handle('PATCH', `/api/projects/AC/sessions/${SESSION}`, {
      permissionMode: 'plan',
    });
    expect(refused.status).toBe(403);
    expect(project.backend.findSession(SESSION)!.permissionModeOverride).toBeUndefined();
  });
});

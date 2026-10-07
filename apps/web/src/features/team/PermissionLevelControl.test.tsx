import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import type { PermissionMode } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProvider } from '@projectman/shared';
import type { ProjectContextValue } from '../../app/contexts';
import { setFetchImplementation } from '../../api/client';
import { ToastContext } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { MemberProfilePage } from './MemberProfilePage';
import { TeamPage } from './TeamPage';
import { PermissionLevelControl } from './PermissionLevelControl';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const mode = (name: PermissionMode) => t(`permissionModes.${name}`);
const approver = (name: 'human' | 'ai' | 'none') => t(`permissionControls.approvers.${name}`);
const modeLabel = () => t('permissionControls.mode');
const approverLabel = () => t('permissionControls.approver');
const asAdmin: Partial<ProjectContextValue> = { isOwner: false };

type Project = ReturnType<typeof mockProject>;

function aiConfig(project: Project, handle: string) {
  const member = project.backend.config.team.members.find((m) => m.handle === handle);
  if (member?.kind !== 'ai') throw new Error(`no AI member ${handle}`);
  return member;
}
/** The agent CLI of a member, in the configuration and in the roster the pages read. */
function setProvider(project: Project, handle: string, provider: AgentProvider) {
  aiConfig(project, handle).provider = provider;
  project.backend.findMember(handle)!.provider = provider;
}
/** The delegation is on and `code-review` can decide for the others. */
function enableAiApprover(project: Project) {
  project.backend.config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
  aiConfig(project, 'code-review').role = 'lead_developer';
  project.backend.syncPermissionViews();
}
const patches = (project: Project, handle: string) =>
  project.requests.filter((r) => r.method === 'PATCH' && r.path.endsWith(`/members/${handle}`));

/** The profile of a member, once its permission control has loaded. */
async function settingsRow(project: Project, handle: string, context?: Partial<ProjectContextValue>) {
  const view = project.render(
    <Routes>
      <Route path="/team/:handle" element={<MemberProfilePage />} />
    </Routes>,
    `/team/${handle}`,
    context,
  );
  await screen.findByLabelText(modeLabel());
  return Object.assign(within(view.container), { unmount: view.unmount });
}
const select = (row: ReturnType<typeof within>, label: string) =>
  row.getByLabelText(label) as HTMLSelectElement;

describe('the permission settings in the member profile of a member', () => {
  it.each([true, false])('uses the draft provider for permission notes: owner %s', (isOwner) => {
    for (const [savedProvider, draftProvider] of [
      ['claude', 'gemini'],
      ['gemini', 'codex'],
    ] as const) {
      const project = mockProject();
      const member = project.backend.findMember('fe-1')!;
      member.provider = savedProvider;
      member.permissionMode = 'auto';
      const ui = project.render(<PermissionLevelControl member={member} provider={draftProvider} />, '/', {
        isOwner,
      });
      const note = screen.queryByText(t('permissionControls.providerNotes.gemini.auto'));
      if (draftProvider === 'gemini') expect(note).toBeTruthy();
      else expect(note).toBeNull();
      expect(project.requests.filter((request) => request.method === 'PATCH')).toHaveLength(0);
      ui.unmount();
    }
  });

  it.each([true, false])('does not explain Auto for legacy Gemini modes: owner %s', (isOwner) => {
    for (const permissionMode of [undefined, 'auto', 'bypassPermissions'] as const) {
      const project = mockProject();
      const member = project.backend.findMember('fe-1')!;
      member.provider = 'gemini';
      member.permissionMode = permissionMode;
      member.permissionLegacy = true;
      const ui = project.render(<PermissionLevelControl member={member} />, '/', { isOwner });
      expect(screen.getByText(t('permissionControls.legacyHint'))).toBeTruthy();
      expect(screen.queryByText(t('permissionControls.providerNotes.gemini.auto'))).toBeNull();
      expect(screen.queryByText(t('permissionControls.providerNotes.gemini.plan'))).toBeNull();
      ui.unmount();
    }
  });

  it.each([true, false])('explains Gemini auto and plan to owners and readers: %s', async (isOwner) => {
    for (const permissionMode of ['default', 'acceptEdits', 'auto', 'plan'] as const) {
      const project = mockProject();
      const member = project.backend.findMember('fe-1')!;
      member.provider = 'gemini';
      member.permissionMode = permissionMode;
      const ui = project.render(<PermissionLevelControl member={member} />, '/', { isOwner });
      if (permissionMode === 'auto' || permissionMode === 'plan') {
        expect(screen.getByText(t(`permissionControls.providerNotes.gemini.${permissionMode}`))).toBeTruthy();
      } else {
        expect(screen.queryByText(t('permissionControls.providerNotes.gemini.auto'))).toBeNull();
        expect(screen.queryByText(t('permissionControls.providerNotes.gemini.plan'))).toBeNull();
      }
      if (isOwner) {
        expect((screen.getByLabelText(modeLabel()) as HTMLSelectElement).options).toHaveLength(4);
        expect(screen.queryByRole('option', { name: mode('bypassPermissions') })).toBeNull();
      }
      ui.unmount();
    }
  });
  it('shows the mode of today’s members unchanged, and asks like a person', async () => {
    const project = mockProject();
    aiConfig(project, 'devops').permissionMode = 'auto';
    project.backend.syncPermissionViews();
    const expected = [
      ['devops', 'auto'],
      ['code-review', 'plan'],
      ['qa', 'default'],
    ] as const;
    for (const [handle, value] of expected) {
      const row = await settingsRow(project, handle);
      expect(select(row, modeLabel()).value).toBe(value);
      if (handle === 'qa') expect(select(row, approverLabel()).value).toBe('human');
      row.unmount();
    }
  });

  it('lets an owner set the mode, saved at once through the member route', async () => {
    const project = mockProject();
    const row = await settingsRow(project, 'qa');
    fireEvent.change(select(row, modeLabel()), { target: { value: 'acceptEdits' } });
    await waitFor(() => expect(patches(project, 'qa')).toHaveLength(1));
    expect(patches(project, 'qa')[0]!.body).toEqual({ permissionMode: 'acceptEdits' });
    expect(project.requests.some((r) => r.method === 'PATCH' && r.path.endsWith('/config'))).toBe(false);
    await waitFor(() => expect(select(row, modeLabel()).value).toBe('acceptEdits'));
    expect(aiConfig(project, 'qa').permissionMode).toBe('acceptEdits');
  });

  it('lets an owner set who answers, saved at once', async () => {
    const project = mockProject();
    const row = await settingsRow(project, 'qa');
    fireEvent.change(select(row, approverLabel()), { target: { value: 'none' } });
    await waitFor(() => expect(patches(project, 'qa')).toHaveLength(1));
    expect(patches(project, 'qa')[0]!.body).toEqual({ approver: 'none' });
    await waitFor(() => expect(select(row, approverLabel()).value).toBe('none'));
    expect(aiConfig(project, 'qa').approver).toBe('none');
  });

  it('lets an owner set the network, saved at once', async () => {
    const project = mockProject();
    const row = await settingsRow(project, 'qa');
    const checkbox = row.getByLabelText(t('permissionControls.network'));
    fireEvent.click(checkbox);
    await waitFor(() => expect(patches(project, 'qa')).toHaveLength(1));
    expect(patches(project, 'qa')[0]!.body).toEqual({ outboundNetwork: false });
  });

  it('tells the owner the network is saved, from the next session on', async () => {
    const project = mockProject();
    const member = project.backend.findMember('qa')!;
    const show = vi.fn();
    project.render(
      <ToastContext.Provider value={{ show }}>
        <PermissionLevelControl member={member} />
      </ToastContext.Provider>,
    );
    fireEvent.click(screen.getByLabelText(t('permissionControls.network')));
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith(
        t('permissionControls.savedNetwork', {
          name: member.displayName,
          value: t('permissionControls.networkValues.off'),
        }),
      ),
    );
  });

  it('shows an error and the stored value when saving the network fails', async () => {
    const project = mockProject();
    const member = project.backend.findMember('qa')!;
    const show = vi.fn();
    const fetch = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (path, init) =>
      init?.method === 'PATCH'
        ? new Response(JSON.stringify({ error: { code: 'forbidden', message: 'No' } }), { status: 403 })
        : fetch(path, init),
    );
    project.render(
      <ToastContext.Provider value={{ show }}>
        <PermissionLevelControl member={member} />
      </ToastContext.Provider>,
    );
    const box = screen.getByLabelText(t('permissionControls.network')) as HTMLInputElement;
    fireEvent.click(box);
    await waitFor(() => expect(show).toHaveBeenCalledWith(expect.any(String), 'error'));
    expect(box.checked).toBe(true);
  });

  it('shows the correct hint for disconnected network based on provider and approver', async () => {
    const project = mockProject();

    // Claude with human approver
    aiConfig(project, 'qa').outboundNetwork = false;
    setProvider(project, 'qa', 'claude');
    aiConfig(project, 'qa').approver = 'human';
    project.backend.syncPermissionViews();
    let row = await settingsRow(project, 'qa');
    expect(row.getByText(t('permissionControls.networkHints.offRefused'))).toBeTruthy();
    row.unmount();

    // Codex with human approver
    aiConfig(project, 'code-review').outboundNetwork = false;
    setProvider(project, 'code-review', 'codex');
    aiConfig(project, 'code-review').approver = 'human';
    project.backend.syncPermissionViews();
    row = await settingsRow(project, 'code-review');
    expect(row.getByText(t('permissionControls.networkHints.off'))).toBeTruthy();
    row.unmount();

    // Codex with no approver
    aiConfig(project, 'code-review').approver = 'none';
    project.backend.syncPermissionViews();
    row = await settingsRow(project, 'code-review');
    expect(row.getByText(t('permissionControls.networkHints.offRefused'))).toBeTruthy();
    row.unmount();

    // Codex with an AI approver asks as well
    aiConfig(project, 'code-review').approver = 'ai';
    project.backend.syncPermissionViews();
    row = await settingsRow(project, 'code-review');
    expect(row.getByText(t('permissionControls.networkHints.off'))).toBeTruthy();
    row.unmount();

    // Gemini with a human approver: refused as well, only Codex asks
    setProvider(project, 'code-review', 'gemini');
    aiConfig(project, 'code-review').approver = 'human';
    project.backend.syncPermissionViews();
    row = await settingsRow(project, 'code-review');
    expect(row.getByText(t('permissionControls.networkHints.offRefused'))).toBeTruthy();
    row.unmount();
  });

  it('shows the network on for a member without the setting, with the hint of the open network', async () => {
    const project = mockProject();
    delete aiConfig(project, 'qa').outboundNetwork;
    project.backend.syncPermissionViews();
    const row = await settingsRow(project, 'qa');
    expect((row.getByLabelText(t('permissionControls.network')) as HTMLInputElement).checked).toBe(true);
    expect(row.getByText(t('permissionControls.networkHints.on'))).toBeTruthy();
  });

  it('lets an owner switch the network back on, and follows the approver in the hint of Codex', async () => {
    const project = mockProject();
    setProvider(project, 'code-review', 'codex');
    aiConfig(project, 'code-review').outboundNetwork = false;
    project.backend.syncPermissionViews();
    const row = await settingsRow(project, 'code-review');
    expect(row.getByText(t('permissionControls.networkHints.off'))).toBeTruthy();
    fireEvent.change(select(row, approverLabel()), { target: { value: 'none' } });
    await waitFor(() => expect(row.getByText(t('permissionControls.networkHints.offRefused'))).toBeTruthy());
    fireEvent.click(row.getByLabelText(t('permissionControls.network')));
    await waitFor(() => expect(aiConfig(project, 'code-review').outboundNetwork).toBe(true));
    expect(patches(project, 'code-review').at(-1)!.body).toEqual({ outboundNetwork: true });
    await waitFor(() => expect(row.getByText(t('permissionControls.networkHints.on'))).toBeTruthy());
  });

  it('shows everyone else the network as text, with no checkbox', () => {
    const project = mockProject();
    const member = project.backend.findMember('qa')!;
    for (const [stored, value] of [
      [false, 'off'],
      [undefined, 'on'],
    ] as const) {
      member.outboundNetwork = stored;
      const ui = project.render(<PermissionLevelControl member={member} />, '/', asAdmin);
      expect(screen.queryByLabelText(t('permissionControls.network'))).toBeNull();
      expect(
        screen.getByText(
          t('permissionControls.networkState', { value: t(`permissionControls.networkValues.${value}`) }),
        ),
      ).toBeTruthy();
      ui.unmount();
    }
  });

  it('offers the four CLI modes and the three approvers, and no bypassPermissions', async () => {
    const project = mockProject();
    const row = await settingsRow(project, 'qa');
    const options = (label: string) =>
      [...select(row, label).options].filter((o) => !o.disabled || o.value).map((o) => o.textContent);
    expect(options(modeLabel())).toEqual([mode('default'), mode('acceptEdits'), mode('plan'), mode('auto')]);
    expect(options(approverLabel())).toEqual([approver('human'), approver('ai'), approver('none')]);
  });

  it('shows everyone else the values without a control', async () => {
    const project = mockProject();
    project.render(
      <Routes>
        <Route path="/team/:handle" element={<MemberProfilePage />} />
      </Routes>,
      '/team/code-review',
      asAdmin,
    );
    const row = within(document.body);
    expect(await row.findByText(approver('human'))).toBeTruthy();
    expect(row.getByText(mode('plan'))).toBeTruthy();
    expect(screen.queryAllByLabelText(modeLabel())).toHaveLength(0);
    expect(screen.queryAllByLabelText(approverLabel())).toHaveLength(0);
  });

  it('disables the AI approver and says why while delegation is off', async () => {
    const project = mockProject();
    const row = await settingsRow(project, 'qa');
    const option = row.getByRole('option', { name: approver('ai') }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(row.getByText(t('permissionControls.blocked.delegation_off'))).toBeTruthy();
    expect((row.getByRole('option', { name: approver('none') }) as HTMLOptionElement).disabled).toBe(false);
  });

  it('says there is no decider while delegation is on but no AI member holds the duty', async () => {
    const project = mockProject();
    project.backend.config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
    project.backend.syncPermissionViews();
    const row = await settingsRow(project, 'qa');
    expect((row.getByRole('option', { name: approver('ai') }) as HTMLOptionElement).disabled).toBe(true);
    expect(row.getByText(t('permissionControls.blocked.no_ai_decider'))).toBeTruthy();
  });

  it('enables the AI approver once delegation is on and an AI member can decide, and saves it', async () => {
    const project = mockProject();
    enableAiApprover(project);
    const row = await settingsRow(project, 'qa');
    expect((row.getByRole('option', { name: approver('ai') }) as HTMLOptionElement).disabled).toBe(false);
    fireEvent.change(select(row, approverLabel()), { target: { value: 'ai' } });
    await waitFor(() => expect(patches(project, 'qa')).toHaveLength(1));
    expect(patches(project, 'qa')[0]!.body).toEqual({ approver: 'ai' });
    await waitFor(() => expect(select(row, approverLabel()).value).toBe('ai'));
  });

  it('shows a legacy "everything allowed" member with the old-setting mark, and no such choice', async () => {
    const project = mockProject();
    aiConfig(project, 'qa').permissionMode = 'bypassPermissions';
    project.backend.syncPermissionViews();
    const row = await settingsRow(project, 'qa');
    expect(row.getAllByText(t('permissionControls.legacy')).length).toBeGreaterThan(0);
    expect(row.queryByRole('option', { name: mode('bypassPermissions') })).toBeNull();
    // Picking a mode replaces the legacy one.
    fireEvent.change(select(row, modeLabel()), { target: { value: 'auto' } });
    await waitFor(() => expect(row.queryAllByText(t('permissionControls.legacy'))).toHaveLength(0));
    expect(aiConfig(project, 'qa').permissionMode).toBe('auto');
  });
});

describe('the permission settings in the member profile', () => {
  const page = () => (
    <Routes>
      <Route path="/team/:handle" element={<MemberProfilePage />} />
    </Routes>
  );

  it('are set from the profile by an owner', async () => {
    const project = mockProject();
    project.render(page(), '/team/fe-1');
    fireEvent.change(await screen.findByLabelText(modeLabel()), { target: { value: 'plan' } });
    await waitFor(() => expect(patches(project, 'fe-1')).toHaveLength(1));
    expect(patches(project, 'fe-1')[0]!.body).toEqual({ permissionMode: 'plan' });
    fireEvent.change(await screen.findByLabelText(approverLabel()), { target: { value: 'none' } });
    await waitFor(() => expect(patches(project, 'fe-1')).toHaveLength(2));
    expect(patches(project, 'fe-1')[1]!.body).toEqual({ approver: 'none' });
  });

  it('show no control to anyone else', async () => {
    const project = mockProject();
    project.render(page(), '/team/fe-1', asAdmin);
    await screen.findByText(approver('human'));
    expect(screen.queryAllByLabelText(modeLabel())).toHaveLength(0);
    expect(screen.queryAllByLabelText(approverLabel())).toHaveLength(0);
  });
});

describe('the server rules in the fake backend', () => {
  const patch = (project: Project, body: unknown) =>
    project.backend.handle('PATCH', '/api/projects/AC/members/qa', body);
  const makeViewerAdmin = (project: Project) => {
    const owner = project.backend.config.team.members.find(
      (m) => m.kind === 'human' && m.handle === 'owner',
    )!;
    if (owner.kind === 'human') owner.access = 'admin';
  };

  it('refuses an admin to change the mode or the approver', () => {
    const project = mockProject();
    makeViewerAdmin(project);
    for (const body of [{ permissionMode: 'plan' }, { approver: 'none' }]) {
      expect(patch(project, body)).toMatchObject({ status: 403, body: { error: { code: 'owner_only' } } });
    }
    expect(aiConfig(project, 'qa').permissionMode).toBe('default');
  });

  it('refuses an AI approver that cannot be chosen, and bypassPermissions', () => {
    const project = mockProject();
    expect(patch(project, { approver: 'ai' })).toMatchObject({
      status: 422,
      body: { error: { code: 'approver_unavailable', details: { blocker: 'delegation_off' } } },
    });
    expect(patch(project, { permissionMode: 'bypassPermissions' })).toMatchObject({ status: 400 });
  });

  it('is refused for a human member', () => {
    const project = mockProject();
    expect(
      project.backend.handle('PATCH', '/api/projects/AC/members/owner', { approver: 'none' }),
    ).toMatchObject({ status: 400, body: { error: { code: 'not_ai_member' } } });
  });
});

describe('the Team page when the AI decider drops out', () => {
  it('warns about the members whose approver is still the AI', async () => {
    const project = mockProject();
    aiConfig(project, 'qa').approver = 'ai';
    project.backend.syncPermissionViews();
    project.render(<TeamPage />);
    const warning = await screen.findByRole('status', { name: t('permissionControls.lostApproverLabel') });
    const name = project.backend.members.find((m) => m.handle === 'qa')!.displayName;
    expect(warning.textContent).toBe(t('permissionControls.lostApprover', { names: name }));
  });

  it('shows no warning while the AI approver has a decider, or nobody uses it', async () => {
    const project = mockProject();
    enableAiApprover(project);
    aiConfig(project, 'qa').approver = 'ai';
    project.backend.syncPermissionViews();
    project.render(<TeamPage />);
    await screen.findByRole('region', { name: t('team.roster') });
    expect(screen.queryByRole('status', { name: t('permissionControls.lostApproverLabel') })).toBeNull();
  });
});

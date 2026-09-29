import { hu as templateLocale } from '@projectman/templates';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { setFetchImplementation } from '../../api/client';
import { builtInRoles } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { EditMemberDialog } from './EditMemberDialog';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('EditMemberDialog', () => {
  it('edits multiple human roles and includes roles with monitoring duties', async () => {
    const project = mockProject();
    const onClose = vi.fn();
    project.render(
      <EditMemberDialog
        member={project.backend.findMember('owner')!}
        config={project.backend.config}
        roles={builtInRoles}
        onClose={onClose}
      />,
    );
    expect(screen.queryByLabelText(t('providerSettings.provider'))).toBeNull();
    expect((screen.getByRole('checkbox', { name: 'Operátor' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('checkbox', { name: templateLocale.roles.watchdog.name })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'QA' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Terméktulajdonos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mentés' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(project.backend.findMember('owner')?.roles).toEqual(['operator', 'qa']);
    expect(project.requests.find((request) => request.method === 'PATCH')?.body).toMatchObject({
      roles: ['operator', 'qa'],
    });
  });
  it('loads AI settings and explicitly clears a schedule', async () => {
    const project = mockProject();
    const config = project.backend.config.team.members.find((member) => member.handle === 'qa')!;
    if (config.kind !== 'ai') throw new Error('Expected AI fixture');
    config.schedule = { cron: '0 8 * * 1-5', prompt: 'Check the Acme shop.' };
    project.render(
      <EditMemberDialog
        member={project.backend.findMember('qa')!}
        config={project.backend.config}
        roles={builtInRoles}
        onClose={() => {}}
      />,
    );
    expect((screen.getByLabelText('Modell') as HTMLSelectElement).value).toBe('sonnet');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ütemezett munka' }));
    fireEvent.change(screen.getByLabelText('Név'), { target: { value: 'Acme QA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mentés' }));
    await waitFor(() =>
      expect(project.requests.find((request) => request.method === 'PATCH')?.body).toMatchObject({
        displayName: 'Acme QA',
        model: 'sonnet',
        schedule: null,
      }),
    );
    expect(config.schedule).toBeUndefined();
  });
  it('switches an AI member to Codex and saves provider, model and effort', async () => {
    const project = mockProject();
    project.backend.providerLoggedIn.codex = false;
    project.render(
      <EditMemberDialog
        member={project.backend.findMember('qa')!}
        config={project.backend.config}
        roles={builtInRoles}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(t('providerSettings.provider')), { target: { value: 'codex' } });
    expect((screen.getByLabelText(t('hire.model')) as HTMLSelectElement).value).toBe('gpt-6.1-sol');
    expect(await screen.findByText(t('providerSettings.loginCommands.codex'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('hire.model')), { target: { value: 'gpt-6-astra' } });
    expect(screen.getByText(t('providerSettings.astraWarning'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('providerSettings.effort')), { target: { value: 'xhigh' } });
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() =>
      expect(project.requests.find((request) => request.method === 'PATCH')?.body).toMatchObject({
        provider: 'codex',
        model: 'gpt-6-astra',
        effort: 'xhigh',
      }),
    );
    expect(project.backend.findMember('qa')).toMatchObject({
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'xhigh',
    });
  });

  it('loads existing custom Codex settings and switches back to Claude', async () => {
    const project = mockProject();
    const config = project.backend.config.team.members.find((member) => member.handle === 'be-1')!;
    if (config.kind !== 'ai') throw new Error('Expected AI fixture');
    config.model = 'fictional-codex-model';
    config.effort = 'high';
    project.backend.providerLoggedIn.claude = false;
    project.render(
      <EditMemberDialog
        member={project.backend.findMember('be-1')!}
        config={project.backend.config}
        roles={builtInRoles}
        onClose={() => {}}
      />,
    );
    expect((screen.getByLabelText(t('providerSettings.provider')) as HTMLSelectElement).value).toBe('codex');
    expect((screen.getByLabelText(t('providerSettings.modelId')) as HTMLInputElement).value).toBe(
      'fictional-codex-model',
    );
    expect((screen.getByLabelText(t('providerSettings.effort')) as HTMLSelectElement).value).toBe('high');
    fireEvent.change(screen.getByLabelText(t('providerSettings.provider')), { target: { value: 'claude' } });
    expect((screen.getByLabelText(t('hire.model')) as HTMLSelectElement).value).toBe('opus');
    expect(screen.queryByLabelText(t('providerSettings.effort'))).toBeNull();
    expect(await screen.findByText(t('providerSettings.loginCommands.claude'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() =>
      expect(project.backend.findMember('be-1')).toMatchObject({ provider: 'claude', model: 'opus' }),
    );
  });
});

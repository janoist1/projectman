import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionMode, PROVIDER_PERMISSION_MODES } from '@projectman/shared';
import { t } from '../../i18n/t';
import { setFetchImplementation } from '../../api/client';
import { builtInRoles } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { HireDialog } from './HireDialog';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('HireDialog', () => {
  it('hires Claude with a fixed model and max effort', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.change(await screen.findByLabelText(t('hire.model')), { target: { value: 'claude-opus-5-5' } });
    fireEvent.change(screen.getByLabelText(t('providerSettings.effort')), { target: { value: 'max' } });
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    await waitFor(() =>
      expect(project.backend.config.team.members.at(-1)).toMatchObject({
        provider: 'claude',
        model: 'claude-opus-5-5',
        effort: 'max',
      }),
    );
    expect(project.requests.find((request) => request.method === 'POST')?.body).toMatchObject({
      effort: 'max',
    });
  });

  it('lists the AI-compatible catalogue and previews custom responsibilities', async () => {
    const project = mockProject();
    project.backend.config.team.roles.push({
      id: 'data_steward',
      name: 'Acme steward',
      summary: 'Keeps reference data clean.',
      notTheirJob: 'Does not change schemas.',
      holders: 'both',
      instructions: 'Check duplicate records.',
    });
    project.backend.config.team.roles.push({
      id: 'human_lead',
      name: 'Acme human lead',
      summary: 'Sets priorities.',
      notTheirJob: '',
      holders: 'human',
      instructions: '',
    });
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    const radios = await screen.findAllByRole('radio');
    expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual([
      ...builtInRoles.filter((role) => role.holders !== 'human').map((role) => role.id),
      'data_steward',
    ]);
    fireEvent.click(radios.at(-1)!);
    expect(screen.getAllByText('Keeps reference data clean.').length).toBeGreaterThan(0);
    expect(screen.getByText(/Does not change schemas/)).toBeTruthy();
  });

  it('fills the weekday preset and submits an optional schedule', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.click(await screen.findByRole('button', { name: 'hétköznap reggel 8' }));
    expect((screen.getByLabelText('Cron') as HTMLInputElement).value).toBe('0 8 * * 1-5');
    fireEvent.change(screen.getByLabelText('Feladat az ütemezett munkához'), {
      target: { value: 'Check the Acme dependencies.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Felveszem' }));
    await waitFor(() =>
      expect(
        project.requests.find((request) => request.method === 'POST' && request.path.endsWith('/members'))
          ?.body,
      ).toMatchObject({
        role: 'developer',
        schedule: { cron: '0 8 * * 1-5', prompt: 'Check the Acme dependencies.' },
      }),
    );
    expect(project.backend.config.team.members.at(-1)).toMatchObject({
      schedule: { cron: '0 8 * * 1-5', prompt: 'Check the Acme dependencies.' },
    });
  });
  it('switches providers, warns about login and cost, and hires with Codex defaults', async () => {
    const project = mockProject();
    project.backend.providerLoggedIn.codex = false;
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    const provider = await screen.findByLabelText(t('providerSettings.provider'));
    expect(screen.getByLabelText(t('providerSettings.effort'))).toBeTruthy();
    fireEvent.change(provider, { target: { value: 'codex' } });
    expect((screen.getByLabelText(t('hire.model')) as HTMLSelectElement).value).toBe('gpt-6.1-sol');
    expect((screen.getByLabelText(t('providerSettings.effort')) as HTMLSelectElement).value).toBe('medium');
    expect(
      Array.from((screen.getByLabelText(t('hire.model')) as HTMLSelectElement).options).map(
        (option) => option.value,
      ),
    ).toEqual(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra', 'custom']);
    expect(await screen.findByText(t('providerSettings.loginCommands.codex'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('hire.model')), { target: { value: 'gpt-6-astra' } });
    expect(screen.getByText(t('providerSettings.astraWarning'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('hire.model')), { target: { value: 'gpt-6.1-sol' } });
    expect(screen.queryByText(t('providerSettings.astraWarning'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    await waitFor(() =>
      expect(project.backend.config.team.members.at(-1)).toMatchObject({
        provider: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'medium',
      }),
    );
    expect(project.requests.find((request) => request.method === 'POST')?.body).toMatchObject({
      provider: 'codex',
      effort: 'medium',
    });
  });

  it('shows a Codex hire only permission modes Codex allows, whatever the role', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.change(await screen.findByLabelText(t('providerSettings.provider')), {
      target: { value: 'codex' },
    });
    for (const radio of screen.getAllByRole('radio')) {
      fireEvent.click(radio);
      const shown = PermissionMode.options.filter(
        (mode) => screen.queryAllByText(t(`permissionModes.${mode}`)).length > 0,
      );
      const role = (radio as HTMLInputElement).value;
      expect(shown.length, role).toBeGreaterThan(0);
      for (const mode of shown) expect(PROVIDER_PERMISSION_MODES.codex, `${role}: ${mode}`).toContain(mode);
    }
    expect(screen.queryAllByText(t('permissionModes.bypassPermissions'))).toEqual([]);
  });

  it('supports custom Codex model ids and resets to Claude defaults on switching back', async () => {
    const project = mockProject();
    project.backend.providerLoggedIn.claude = false;
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    const provider = await screen.findByLabelText(t('providerSettings.provider'));
    expect(await screen.findByText(t('providerSettings.loginCommands.claude'))).toBeTruthy();
    fireEvent.change(provider, { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText(t('hire.model')), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText(t('providerSettings.modelId')), {
      target: { value: 'fictional-codex-model' },
    });
    fireEvent.change(provider, { target: { value: 'claude' } });
    expect((screen.getByLabelText(t('hire.model')) as HTMLSelectElement).value).toBe('opus');
    expect(screen.getByLabelText(t('providerSettings.effort'))).toBeTruthy();
    fireEvent.change(provider, { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText(t('hire.model')), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText(t('providerSettings.modelId')), {
      target: { value: 'fictional-codex-model' },
    });
    fireEvent.change(screen.getByLabelText(t('providerSettings.effort')), { target: { value: 'low' } });
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    await waitFor(() =>
      expect(project.backend.config.team.members.at(-1)).toMatchObject({
        provider: 'codex',
        model: 'fictional-codex-model',
        effort: 'low',
      }),
    );
  });
  it('keeps the Codex default when changing to a role with an expensive existing model', async () => {
    const project = mockProject();
    const qa = project.backend.config.team.members.find((member) => member.handle === 'qa')!;
    if (qa.kind !== 'ai') throw new Error('Expected AI fixture');
    qa.provider = 'codex';
    qa.model = 'gpt-6-astra';
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.change(await screen.findByLabelText(t('providerSettings.provider')), {
      target: { value: 'codex' },
    });
    fireEvent.click(
      screen.getAllByRole('radio').find((entry) => (entry as HTMLInputElement).value === 'qa')!,
    );
    expect((screen.getByLabelText(t('hire.model')) as HTMLSelectElement).value).toBe('gpt-6.1-sol');
    expect(screen.queryByText(t('providerSettings.astraWarning'))).toBeNull();
  });
});

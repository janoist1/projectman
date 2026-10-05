import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../i18n/t';
import { setFetchImplementation } from '../../api/client';
import { builtInRoles } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { HireDialog } from './HireDialog';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('HireDialog', () => {
  it('hires Gemini with medium effort and login steps without a cheap subagent', async () => {
    const project = mockProject();
    project.backend.providerStatus.gemini = { loggedIn: false, problem: 'not_logged_in' };
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.change(await screen.findByLabelText(t('providerSettings.provider')), {
      target: { value: 'gemini' },
    });
    expect((screen.getByLabelText(t('providerSettings.effort')) as HTMLSelectElement).value).toBe('medium');
    expect((screen.getByLabelText(t('providerSettings.cheapSubagent')) as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect((await screen.findByRole('alert')).textContent).toContain(t('providerSettings.loginSteps.gemini'));
    expect(screen.getByText('agy').tagName).toBe('CODE');
    expect(screen.getByText(t('permissionControls.providerNotes.gemini.auto'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    await waitFor(() =>
      expect(project.backend.config.team.members.at(-1)).toMatchObject({
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        effort: 'medium',
      }),
    );
    expect(project.backend.config.team.members.at(-1)).not.toHaveProperty('cheapSubagent');
  });
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

  it('hires a Claude member with a cheap subagent (PM-179)', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.change(await screen.findByLabelText(t('providerSettings.cheapSubagent')), {
      target: { value: 'sonnet' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    await waitFor(() =>
      expect(project.backend.config.team.members.at(-1)).toMatchObject({ cheapSubagent: 'sonnet' }),
    );
  });

  it('hires a Codex member without a cheap subagent, whatever was picked before (PM-179)', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.change(await screen.findByLabelText(t('providerSettings.cheapSubagent')), {
      target: { value: 'haiku' },
    });
    fireEvent.change(screen.getByLabelText(t('providerSettings.provider')), { target: { value: 'codex' } });
    expect((screen.getByLabelText(t('providerSettings.cheapSubagent')) as HTMLSelectElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    await waitFor(() =>
      expect(project.backend.config.team.members.at(-1)).toMatchObject({ provider: 'codex' }),
    );
    expect(project.backend.config.team.members.at(-1)).not.toHaveProperty('cheapSubagent');
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
    const select = (await screen.findByLabelText(t('hire.roles'))) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      ...builtInRoles.filter((role) => role.holders !== 'human').map((role) => role.id),
      'data_steward',
    ]);
    fireEvent.change(select, { target: { value: 'data_steward' } });
    expect(screen.getAllByText('Keeps reference data clean.').length).toBeGreaterThan(0);
    const notTheirJob = screen.getByText(/Does not change schemas/);
    // The rest of the template sits in the closed "Részletek" fold.
    expect(notTheirJob.closest('details')!.open).toBe(false);
  });

  it('puts the dialog buttons in the pinned footer, cancel before the main button', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    const submit = await screen.findByRole('button', { name: t('hire.submit') });
    expect(submit.getAttribute('type')).toBe('submit');
    expect(submit.previousElementSibling?.textContent).toBe(t('common.cancel'));
    expect(submit.closest('form')).toBeNull();
  });

  it('opens the fold and focuses the identifier when it is not valid', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    const summary = (await screen.findByText(t('hire.details'))).closest('summary')!;
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(summary);
    fireEvent.change(screen.getByLabelText(new RegExp(`^${t('hire.handle')}`)), {
      target: { value: 'Not Valid!' },
    });
    fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    const handle = await screen.findByLabelText(new RegExp(`^${t('hire.handle')}`));
    await waitFor(() => expect(summary.getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(handle));
    expect(screen.getByText(t('hire.handleInvalid'))).toBeTruthy();
  });

  it('submits a weekday schedule from a frequency and a time, 08:00 to start with', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: t('schedules.form.enabled') }));
    expect(screen.queryByLabelText(t('schedules.form.cron'))).toBeNull();
    expect(
      (screen.getByLabelText(new RegExp(`^${t('schedules.form.time')}`)) as HTMLInputElement).value,
    ).toBe('08:00');
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
  it('builds a daily cron from the time, and shows the cron field only for a custom schedule', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: t('schedules.form.enabled') }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.daily') }));
    fireEvent.change(screen.getByLabelText(new RegExp(`^${t('schedules.form.time')}`)), {
      target: { value: '14:30' },
    });
    fireEvent.change(screen.getByLabelText('Feladat az ütemezett munkához'), { target: { value: 'Check.' } });
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    await waitFor(() =>
      expect(project.requests.find((request) => request.method === 'POST')?.body).toMatchObject({
        schedule: { cron: '30 14 * * *', prompt: 'Check.' },
      }),
    );
  });

  it('keeps a custom cron as typed', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: t('schedules.form.enabled') }));
    fireEvent.click(screen.getByRole('button', { name: t('schedules.form.custom') }));
    fireEvent.change(screen.getByLabelText(t('schedules.form.cron')), { target: { value: '*/15 * * * *' } });
    fireEvent.change(screen.getByLabelText('Feladat az ütemezett munkához'), { target: { value: 'Check.' } });
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    await waitFor(() =>
      expect(project.requests.find((request) => request.method === 'POST')?.body).toMatchObject({
        schedule: { cron: '*/15 * * * *', prompt: 'Check.' },
      }),
    );
  });

  it('refuses a schedule with no task, with the banner above the buttons and the field focused', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: t('schedules.form.enabled') }));
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    expect(await screen.findByText(t('schedules.form.invalid'))).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Feladat az ütemezett munkához')),
    );
    expect(project.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('drops the schedule banner when the identifier is the next thing refused', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: t('schedules.form.enabled') }));
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    expect(await screen.findByText(t('schedules.form.invalid'))).toBeTruthy();
    fireEvent.click((await screen.findByText(t('hire.details'))).closest('summary')!);
    fireEvent.change(screen.getByLabelText(new RegExp(`^${t('hire.handle')}`)), {
      target: { value: 'Not Valid!' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('hire.submit') }));
    expect(await screen.findByText(t('hire.handleInvalid'))).toBeTruthy();
    expect(screen.queryByText(t('schedules.form.invalid'))).toBeNull();
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

  it('shows Auto as the mode of a hire, for every role and for a Codex member too, with nobody to ask', async () => {
    const project = mockProject();
    project.render(<HireDialog open onClose={() => {}} config={project.backend.config} />);
    const fact = async (label: string) => (await screen.findByText(label)).parentElement!.textContent;
    for (const provider of ['claude', 'codex']) {
      fireEvent.change(await screen.findByLabelText(t('providerSettings.provider')), {
        target: { value: provider },
      });
      const select = screen.getByLabelText(t('hire.roles')) as HTMLSelectElement;
      for (const role of Array.from(select.options).map((option) => option.value)) {
        fireEvent.change(select, { target: { value: role } });
        expect(await fact(t('hire.permissionMode')), `${provider}: ${role}`).toBe(
          `${t('hire.permissionMode')}${t('permissionModes.auto')}`,
        );
        expect(await fact(t('hire.approver')), `${provider}: ${role}`).toBe(
          `${t('hire.approver')}${t('permissionControls.approvers.none')}`,
        );
      }
    }
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
    fireEvent.change(screen.getByLabelText(t('hire.roles')), { target: { value: 'qa' } });
    expect((screen.getByLabelText(t('hire.model')) as HTMLSelectElement).value).toBe('gpt-6.1-sol');
    expect(screen.queryByText(t('providerSettings.astraWarning'))).toBeNull();
  });
});

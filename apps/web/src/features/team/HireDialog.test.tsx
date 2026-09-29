import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { builtInRoles } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { HireDialog } from './HireDialog';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('HireDialog', () => {
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
});

import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { mockProject } from '../../test/mockProject';
import { TeamPage } from './TeamPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('TeamPage role catalogue', () => {
  it('shows every human responsibility next to access and one role for AI members', async () => {
    const project = mockProject();
    project.render(<TeamPage />);
    const owner = (await screen.findByText('Te')).closest('tr')!;
    expect(within(owner).getByText('Tulajdonos')).toBeTruthy();
    await waitFor(() => expect(within(owner).getByText('Operátor')).toBeTruthy());
    expect(within(owner).getByText('Terméktulajdonos')).toBeTruthy();
    const frontend = screen.getByText('Frontend fejlesztő').closest('tr')!;
    expect(within(frontend).getByText('Fejlesztő')).toBeTruthy();
    expect(within(owner).getByRole('button', { name: 'Tag szerkesztése: Te' })).toBeTruthy();
  });
  it('allows non-admins to see the catalogue without offering configuration changes', async () => {
    const project = mockProject();
    project.render(<TeamPage />, '/', {
      can: { createTasks: true, manageTeam: false, workInSessions: false },
    });
    await screen.findByRole('heading', { name: 'Szerepek' });
    await waitFor(() => expect(screen.getAllByText('Operátor').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Új szerep' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Tag szerkesztése/ })).toBeNull();
    expect(project.requests.some((request) => request.path.endsWith('/config'))).toBe(false);
  });
});

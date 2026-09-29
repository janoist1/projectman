import { hu as templateLocale } from '@projectman/templates';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});

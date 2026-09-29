import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { mockProject } from '../../test/mockProject';
import { RoleSection } from './RoleSection';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const steward = {
  id: 'data_steward',
  name: 'Acme steward',
  summary: 'Keeps data clean.',
  notTheirJob: 'Does not change schemas.',
  holders: 'both' as const,
  instructions: 'Check duplicate records.',
};

describe('custom roles', () => {
  it('creates all fields, keeps built-ins read-only, and edits instructions', async () => {
    const project = mockProject();
    project.render(<RoleSection config={project.backend.config} />);
    await screen.findByText('Operátor');
    expect(within(screen.getByText('Operátor').closest('li')!).queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Új szerep' }));
    fireEvent.change(screen.getByLabelText('Azonosító'), { target: { value: steward.id } });
    fireEvent.change(screen.getByLabelText('Név'), { target: { value: steward.name } });
    fireEvent.change(screen.getByLabelText('Feladata'), { target: { value: steward.summary } });
    fireEvent.change(screen.getByLabelText('Nem az ő feladata'), { target: { value: steward.notTheirJob } });
    fireEvent.change(screen.getByLabelText('AI-utasítások (angolul)'), {
      target: { value: steward.instructions },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mentés' }));
    await screen.findByText(steward.name);
    expect(project.backend.config.team.roles).toEqual([steward]);
    fireEvent.click(screen.getByRole('button', { name: 'Szerkesztés' }));
    expect((screen.getByLabelText('AI-utasítások (angolul)') as HTMLTextAreaElement).value).toBe(
      steward.instructions,
    );
    expect((screen.getByLabelText('Azonosító') as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText('Feladata'), { target: { value: 'Checks master data too.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mentés' }));
    await screen.findByText('Checks master data too.');
    expect(project.backend.config.team.roles[0]?.instructions).toBe(steward.instructions);
  });
  it('shows member handles when deletion or holder changes conflict', async () => {
    const project = mockProject();
    project.backend.config.team.roles.push(steward);
    project.backend.handle('POST', '/api/projects/AC/members', { role: steward.id, handle: 'acme-steward' });
    project.render(<RoleSection config={project.backend.config} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Szerkesztés' }));
    fireEvent.change(screen.getByLabelText('Ki töltheti be?'), { target: { value: 'human' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mentés' }));
    expect((await screen.findByRole('alert')).textContent).toContain('acme-steward');
    fireEvent.click(screen.getByRole('button', { name: 'Mégse' }));
    fireEvent.click(screen.getByRole('button', { name: 'Törlés' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Törlés' }));
    expect((await screen.findByRole('alert')).textContent).toContain('acme-steward');
    expect(project.backend.config.team.roles).toHaveLength(1);
  });
  it('deletes an unused custom role after confirmation', async () => {
    const project = mockProject();
    project.backend.config.team.roles.push(steward);
    project.render(<RoleSection config={project.backend.config} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Törlés' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Törlés' }));
    await waitFor(() => expect(screen.queryByText(steward.name)).toBeNull());
    expect(project.backend.config.team.roles).toEqual([]);
  });
});

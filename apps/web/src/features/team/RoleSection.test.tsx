import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { getLocale } from '@projectman/templates';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { RoleSection } from './RoleSection';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const operator = getLocale('hu').roles.operator.name;
const steward = {
  id: 'data_steward',
  name: 'Acme steward',
  summary: 'Keeps data clean.',
  notTheirJob: 'Does not change schemas.',
  holders: 'both' as const,
  duties: [],
  instructions: 'Check duplicate records.',
};

describe('custom roles', () => {
  it('creates all fields, keeps built-ins read-only, and edits instructions', async () => {
    const project = mockProject();
    project.render(<RoleSection config={project.backend.config} />);
    await screen.findByText(operator);
    expect(within(screen.getByText(operator).closest('li')!).queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('roleCatalogue.create') }));
    fireEvent.change(screen.getByLabelText(t('roleCatalogue.id')), { target: { value: steward.id } });
    fireEvent.change(screen.getByLabelText(t('roleCatalogue.name')), { target: { value: steward.name } });
    fireEvent.change(screen.getByLabelText(t('roleCatalogue.summary')), {
      target: { value: steward.summary },
    });
    fireEvent.change(screen.getByLabelText(t('roleCatalogue.notTheirJob')), {
      target: { value: steward.notTheirJob },
    });
    fireEvent.change(screen.getByLabelText(t('roleCatalogue.instructions')), {
      target: { value: steward.instructions },
    });
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await screen.findByText(steward.name);
    expect(project.requests.find((request) => request.method === 'POST')).toMatchObject({
      path: '/api/projects/AC/roles',
      body: steward,
    });
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.edit') }));
    expect((screen.getByLabelText(t('roleCatalogue.instructions')) as HTMLTextAreaElement).value).toBe(
      steward.instructions,
    );
    expect((screen.getByLabelText(t('roleCatalogue.id')) as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText(t('roleCatalogue.summary')), {
      target: { value: 'Checks master data too.' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('memberEdit.save') }));
    await screen.findByText('Checks master data too.');
    expect(project.requests.find((request) => request.method === 'PUT')).toMatchObject({
      path: `/api/projects/AC/roles/${steward.id}`,
      body: { ...steward, summary: 'Checks master data too.' },
    });
  });
  it('shows member handles when deletion conflicts with active membership', async () => {
    const project = mockProject();
    project.backend.config.team.roles.push(steward);
    project.backend.handle('POST', '/api/projects/AC/members', { role: steward.id, handle: 'acme-steward' });
    project.render(<RoleSection config={project.backend.config} />);
    await screen.findByText(steward.name);
    fireEvent.click(screen.getByRole('button', { name: t('roleCatalogue.delete') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: t('roleCatalogue.delete') }));
    expect((await screen.findByRole('alert')).textContent).toContain('acme-steward');
    expect(screen.getByText(steward.name)).toBeTruthy();
  });
  it('deletes an unused custom role after confirmation', async () => {
    const project = mockProject();
    project.backend.config.team.roles.push(steward);
    project.render(
      <ToastProvider>
        <RoleSection config={project.backend.config} />
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: t('roleCatalogue.delete') }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: t('roleCatalogue.delete') }),
    );
    await waitFor(() => expect(screen.queryByText(steward.name)).toBeNull());
    expect(await screen.findByText(t('roleCatalogue.deleted'))).toBeTruthy();
    expect(project.requests.some((request) => request.method === 'DELETE')).toBe(true);
  });
});

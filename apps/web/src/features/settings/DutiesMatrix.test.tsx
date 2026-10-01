import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getLocale } from '@projectman/templates';
import { setFetchImplementation } from '../../api/client';
import { mockProject } from '../../test/mockProject';
import { t } from '../../i18n/t';
import { SettingsPage } from './SettingsPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
async function matrix() {
  return within(await screen.findByRole('region', { name: t('duties.title') }));
}

describe('duty matrix', () => {
  it('saves a built-in bundle, resets it, and shows coverage by people', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    let region = await matrix();
    const locale = getLocale(project.backend.config.project.language);
    const label = `${locale.duties.research.name}: ${locale.roles.developer.name}`;
    fireEvent.click(region.getByLabelText(label));
    fireEvent.click(region.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() =>
      expect(project.backend.config.team.roleOverrides?.developer?.duties).toContain('research'),
    );
    region = await matrix();
    await waitFor(() => expect(region.queryByRole('button', { name: t('memberEdit.save') })).toBeNull());
    fireEvent.click(region.getByRole('button', { name: t('duties.reset') }));
    fireEvent.click(region.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() => expect(project.backend.config.team.roleOverrides?.developer).toBeUndefined());
    region = await matrix();
    fireEvent.click(region.getByRole('button', { name: t('duties.people') }));
    expect(
      region
        .getAllByRole('checkbox')
        .every(
          (input) =>
            (input as HTMLInputElement).disabled || input === region.getByLabelText(t('duties.fourEyes')),
        ),
    ).toBe(true);
  });
  it('disables human-only duties for AI roles and release changes for admins', async () => {
    const project = mockProject();
    project.backend.viewerHandle = 'kata';
    const admin = project.backend.config.team.members.find((m) => m.handle === 'kata')!;
    if (admin.kind === 'human') admin.access = 'admin';
    project.render(<SettingsPage />, '/', { isOwner: false, myHandle: 'kata' });
    const region = await matrix();
    const locale = getLocale(project.backend.config.project.language);
    expect(
      (
        region.getByLabelText(
          `${locale.duties.final_decision.name}: ${locale.roles.developer.name}`,
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        region.getByLabelText(
          `${locale.duties.release_approval.name}: ${locale.roles.operator.name}`,
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(region.getAllByText(t('duties.missing')).length).toBeGreaterThan(0);
    expect(region.getAllByText(t('duties.ownerOnly')).length).toBeGreaterThan(0);
  });
  it('edits the three texts of built-in and custom roles', async () => {
    const project = mockProject();
    project.backend.config.team.roles.push({
      id: 'data_steward',
      name: 'Data steward',
      summary: 'Keeps the reference data clean.',
      notTheirJob: '',
      holders: 'both',
      duties: ['docs'],
      instructions: '',
    });
    project.render(<SettingsPage />);
    const region = await matrix();
    const locale = getLocale(project.backend.config.project.language);
    const field = (key: 'summary' | 'notTheirJob' | 'whenToAsk', role: string) =>
      region.getByLabelText(`${t(`roleCatalogue.${key}`)}: ${role}`) as HTMLTextAreaElement;
    const developer = locale.roles.developer.name;
    expect(field('whenToAsk', developer).value).toBe(locale.roles.developer.whenToAsk);
    fireEvent.change(field('whenToAsk', developer), { target: { value: 'Ha kész a kártya.' } });
    fireEvent.change(field('notTheirJob', developer), { target: { value: 'Nem dönt.' } });
    fireEvent.change(field('summary', developer), { target: { value: locale.roles.developer.summary } });
    fireEvent.change(field('whenToAsk', 'Data steward'), { target: { value: 'When data looks wrong.' } });
    fireEvent.change(field('notTheirJob', 'Data steward'), {
      target: { value: 'Does not change the schema.' },
    });
    fireEvent.click(region.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() =>
      expect(project.backend.config.team.roleOverrides?.developer).toEqual({
        duties: ['implementation'],
        instructions: '',
        notTheirJob: 'Nem dönt.',
        whenToAsk: 'Ha kész a kártya.',
      }),
    );
    expect(project.backend.config.team.roles[0]).toMatchObject({
      whenToAsk: 'When data looks wrong.',
      notTheirJob: 'Does not change the schema.',
    });
  });
  it('opens custom role creation from the matrix', async () => {
    const project = mockProject();
    project.render(<SettingsPage />);
    const region = await matrix();
    fireEvent.click(region.getByRole('button', { name: t('duties.add') }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(t('roleCatalogue.id')), { target: { value: 'example_role' } });
    fireEvent.change(dialog.getByLabelText(t('roleCatalogue.name')), { target: { value: 'Example role' } });
    fireEvent.change(dialog.getByLabelText(t('roleCatalogue.summary')), {
      target: { value: 'Researches examples.' },
    });
    fireEvent.click(dialog.getByRole('button', { name: t('memberEdit.save') }));
    await waitFor(() =>
      expect(project.backend.config.team.roles.some((r) => r.id === 'example_role')).toBe(true),
    );
    await screen.findByRole('columnheader', { name: /Example role/ });
  });
});

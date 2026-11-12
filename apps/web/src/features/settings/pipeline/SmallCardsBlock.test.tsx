import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '../../../components/Toast';
import { t, tDynamic } from '../../../i18n/t';
import { mockProject } from '../../../test/mockProject';
import { SettingsTestRoutes } from '../testRoutes';

const rule = (key: string, values?: Record<string, string | number>) =>
  tDynamic(`settings.pipeline.edit.smallRule.${key}`, key, values);

beforeEach(() => window.localStorage.clear());

function renderStage(id = 'qa') {
  const project = mockProject();
  project.render(
    <ToastProvider>
      <SettingsTestRoutes initialSection="pipeline" />
    </ToastProvider>,
    `/p/AC/settings/pipeline?show=stage:${id}`,
  );
  return project;
}

async function panel() {
  const dialog = within(await screen.findByRole('dialog'));
  await dialog.findByLabelText(t('settings.pipeline.edit.name'));
  return dialog;
}

function patches(project: ReturnType<typeof mockProject>) {
  return project.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/config'));
}

/** Picks a member in the last open picker of the panel (the small-card owners come after the stage's own). */
function addSmallOwner(dialog: ReturnType<typeof within>, query: string) {
  const buttons = dialog.getAllByRole('button', { name: t('settings.pipeline.edit.addMember') });
  fireEvent.click(buttons[buttons.length - 1]!);
  const search = dialog.getByRole('combobox', { name: t('settings.pipeline.edit.memberSearch') });
  fireEvent.change(search, { target: { value: query } });
  fireEvent.keyDown(search, { key: 'Enter' });
}

function savedStage(project: ReturnType<typeof mockProject>, id: string) {
  return project.backend.config.pipeline.stages.find((stage) => stage.id === id)!;
}

describe('small-card block of the stage panel', () => {
  it('is only on a step stage', async () => {
    renderStage('dev');
    const dialog = await panel();
    expect(dialog.queryByRole('checkbox', { name: rule('toggle') })).toBeNull();
  });

  it('switches on with three points, and saves the rule with the owners and the trimmed patterns', async () => {
    const project = renderStage();
    const dialog = await panel();
    fireEvent.click(dialog.getByRole('checkbox', { name: rule('toggle') }));
    expect((dialog.getByLabelText(rule('pointsBefore')) as HTMLSelectElement).value).toBe('3');
    addSmallOwner(dialog, 'kata');
    fireEvent.change(dialog.getByLabelText(rule('paths')), {
      target: { value: '  packages/shared/**  \n\n apps/server/src/db/** ' },
    });
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));

    await waitFor(() => expect(patches(project)).toHaveLength(1));
    expect(savedStage(project, 'qa').smallCards).toEqual({
      maxPoints: 3,
      owners: ['kata'],
      centralPaths: ['packages/shared/**', 'apps/server/src/db/**'],
    });
    // The path overview names the rule on the stage's row.
    const overview = t('howWeWork.flow.smallCards', { points: 3, names: 'Kata' });
    expect((await screen.findAllByText(overview, { exact: false })).length).toBeGreaterThan(0);
  });

  it('keeps what was typed when the rule is switched off, and saves a stage without the rule', async () => {
    const project = renderStage();
    const dialog = await panel();
    const toggle = dialog.getByRole('checkbox', { name: rule('toggle') });
    fireEvent.click(toggle);
    fireEvent.change(dialog.getByLabelText(rule('paths')), { target: { value: 'docs/**' } });
    fireEvent.click(toggle);
    expect(dialog.queryByLabelText(rule('paths'))).toBeNull();
    fireEvent.click(toggle);
    expect((dialog.getByLabelText(rule('paths')) as HTMLTextAreaElement).value).toBe('docs/**');

    fireEvent.click(toggle);
    fireEvent.change(dialog.getByLabelText(t('settings.pipeline.edit.name')), { target: { value: 'QA 2' } });
    fireEvent.click(dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }));
    await waitFor(() => expect(patches(project)).toHaveLength(1));
    expect(savedStage(project, 'qa').smallCards).toBeUndefined();
  });

  it('refuses a rule without an owner, under the field', async () => {
    renderStage();
    const dialog = await panel();
    fireEvent.click(dialog.getByRole('checkbox', { name: rule('toggle') }));
    await dialog.findByText(rule('errors.noOwner'));
    expect(
      (dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('names the line of an invalid pattern, counting the blank ones, and ties it to the field', async () => {
    renderStage();
    const dialog = await panel();
    fireEvent.click(dialog.getByRole('checkbox', { name: rule('toggle') }));
    addSmallOwner(dialog, 'kata');
    const paths = dialog.getByLabelText(rule('paths'));
    fireEvent.change(paths, { target: { value: 'docs/**\n\n/absolute' } });

    await dialog.findByText(rule('errors.invalidPath', { line: 3, pattern: '/absolute' }));
    expect(paths.getAttribute('aria-invalid')).toBe('true');
    const described = paths.getAttribute('aria-describedby')!.split(' ');
    expect(described.some((id) => document.getElementById(id)?.textContent?.includes('/absolute'))).toBe(
      true,
    );
    expect(
      (dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('refuses more than fifty patterns', async () => {
    renderStage();
    const dialog = await panel();
    fireEvent.click(dialog.getByRole('checkbox', { name: rule('toggle') }));
    addSmallOwner(dialog, 'kata');
    const lines = Array.from({ length: 51 }, (_, index) => `dir${index}/**`).join('\n');
    fireEvent.change(dialog.getByLabelText(rule('paths')), { target: { value: lines } });
    await dialog.findByText(rule('errors.tooManyPaths'));
  });

  it('says in a live summary what the rule does, and who keeps the other cards', async () => {
    renderStage();
    const dialog = await panel();
    fireEvent.click(dialog.getByRole('checkbox', { name: rule('toggle') }));
    const summary = dialog.getByText(rule('summaryNobody', { points: 3 })).parentElement!;
    expect(summary.getAttribute('aria-live')).toBe('polite');
    addSmallOwner(dialog, 'kata');
    expect(summary.textContent).toContain('Kata');
    expect(dialog.queryByText(rule('summaryNobody', { points: 3 }))).toBeNull();
  });

  it('warns, without blocking the save, that an owner cannot set the label the next gate needs', async () => {
    renderStage();
    const dialog = await panel();
    fireEvent.click(dialog.getByRole('checkbox', { name: rule('toggle') }));
    addSmallOwner(dialog, 'kata');
    const link = await dialog.findByRole('link', { name: rule('warnings.labelSetters') });
    expect(link.getAttribute('href')).toMatch(/^\/p\/AC\/settings\/labels\?show=label%3A/);
    expect(
      (dialog.getByRole('button', { name: t('settings.pipeline.edit.save') }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

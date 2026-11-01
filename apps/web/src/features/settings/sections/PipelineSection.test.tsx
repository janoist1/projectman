import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { getTemplate, templates } from '@projectman/templates';
import { t } from '../../../i18n/t';
import { mockProject } from '../../../test/mockProject';
import { SettingsTestRoutes } from '../testRoutes';
import { columnRuns, emptyColumns } from '../pipeline/flow';

const PIPELINE = '/p/AC/settings/pipeline';

beforeEach(() => window.localStorage.clear());

async function pipelineSection() {
  return screen.findByRole('region', { name: t('settings.sections.pipeline') });
}

const member = { can: { manageTeam: false, createTasks: false, workInSessions: false }, isOwner: false };

describe('pipeline section', () => {
  it.each(templates.map((template) => template.id))('draws every stage of the %s template', async (id) => {
    const project = mockProject();
    project.backend.config = getTemplate(id)!.build({
      key: 'AC',
      name: 'Acme',
      workspacePath: '/work/acme',
      language: 'hu',
      owner: { handle: 'owner', displayName: 'Owner', email: 'owner@example.com' },
    });
    project.render(<SettingsTestRoutes initialSection="pipeline" />, PIPELINE);
    const section = await pipelineSection();
    const { pipeline } = project.backend.config;
    await waitFor(() =>
      expect(section.querySelectorAll('[data-show^="stage:"]')).toHaveLength(pipeline.stages.length),
    );
    expect(section.querySelectorAll('[data-show^="column:"]')).toHaveLength(
      columnRuns(pipeline).length + emptyColumns(pipeline).length,
    );
  });

  it('shows no identifier in the overview, a scattered column twice and an empty column at the bottom', async () => {
    const project = mockProject();
    const { pipeline } = project.backend.config;
    pipeline.stages.find((stage) => stage.id === 'integration')!.columnId = 'dev';
    pipeline.columns.push({ id: 'spare', name: 'Tartalék' });
    project.render(<SettingsTestRoutes initialSection="pipeline" />, PIPELINE);
    const section = await pipelineSection();
    await waitFor(() => expect(section.querySelectorAll('[data-show^="stage:"]').length).toBeGreaterThan(0));
    expect(section.querySelector('code')).toBeNull();
    expect(within(section).queryByText('code_review')).toBeNull();
    expect(columnRuns(pipeline).filter((run) => run.column.id === 'dev').length).toBeGreaterThan(1);
    const heads = [...section.querySelectorAll('[data-show^="column:"]')];
    expect(heads.at(-1)?.getAttribute('data-show')).toBe('column:spare');
    expect(heads).toHaveLength(columnRuns(pipeline).length + 1);
  });

  it('gives a member no edit button', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="pipeline" />, PIPELINE, member);
    const section = await pipelineSection();
    await waitFor(() => expect(section.querySelectorAll('[data-show^="stage:"]').length).toBeGreaterThan(0));
    expect(within(section).queryByRole('button', { name: t('memberEdit.edit') })).toBeNull();
  });

  it('opens the panel of the stage named in the link, with its identifier and a note for a member', async () => {
    const project = mockProject();
    project.render(
      <SettingsTestRoutes initialSection="pipeline" />,
      `${PIPELINE}?show=stage:code_review`,
      member,
    );
    const dialog = within(await screen.findByRole('dialog'));
    const name = project.backend.config.pipeline.stages.find((stage) => stage.id === 'code_review')!.name;
    expect(dialog.getByRole('heading', { name })).toBeTruthy();
    expect(dialog.getByText('code_review', { selector: 'code' })).toBeTruthy();
    expect(dialog.getByText(t('settings.pipeline.memberNote'))).toBeTruthy();
    const section = await pipelineSection();
    expect(section.querySelector('[data-show="stage:code_review"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('says in the panel that a work stage has no handler', async () => {
    const project = mockProject();
    project.backend.config.pipeline.stages.find((stage) => stage.id === 'dev')!.owners = [];
    project.render(<SettingsTestRoutes initialSection="pipeline" />, `${PIPELINE}?show=stage:dev`);
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(t('howWeWork.flow.noOwner'))).toBeTruthy();
  });

  it('opens the panel of a column from its heading, listing its stages', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="pipeline" />, PIPELINE);
    const section = await pipelineSection();
    await waitFor(() => expect(section.querySelector('[data-show="column:review"]')).not.toBeNull());
    fireEvent.click(section.querySelector('[data-show="column:review"]')!);
    const dialog = within(await screen.findByRole('dialog'));
    const inColumn = project.backend.config.pipeline.stages.filter((stage) => stage.columnId === 'review');
    for (const stage of inColumn) expect(dialog.getByRole('button', { name: stage.name })).toBeTruthy();
    expect(dialog.getByText('review', { selector: 'code' })).toBeTruthy();
  });

  it('offers the way back to "Hogyan dolgozunk" when the link came from there', async () => {
    const project = mockProject();
    project.render(
      <SettingsTestRoutes initialSection="pipeline" />,
      `${PIPELINE}?show=stage:code_review&from=how-we-work`,
    );
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('link', { name: t('settings.pipeline.back') }).getAttribute('href')).toBe(
      '/p/AC/how-we-work?show=stage:code_review',
    );
  });

  it('tells that a stage named in the link is gone', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="pipeline" />, `${PIPELINE}?show=stage:nothing`);
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(t('settings.detail.goneBody'))).toBeTruthy();
  });

  it('marks the stage a saved-settings problem points at', async () => {
    const project = mockProject();
    project.backend.config.pipeline.labels.find((label) => label.id === 'release-approved')!.setBy = 'humans';
    project.render(<SettingsTestRoutes initialSection="pipeline" />, PIPELINE);
    const section = await pipelineSection();
    await waitFor(() =>
      expect(within(section).getAllByRole('img', { name: t('settings.pipeline.problem') })).toHaveLength(1),
    );
  });

  it('shows the first-use tip once', async () => {
    const project = mockProject();
    const ui = project.render(<SettingsTestRoutes initialSection="pipeline" />, PIPELINE);
    const section = await pipelineSection();
    fireEvent.click(
      await within(section).findByRole('button', { name: t('settings.pipeline.intro.dismiss') }),
    );
    expect(within(section).queryByText(t('settings.pipeline.intro.title'))).toBeNull();
    ui.unmount();
    project.render(<SettingsTestRoutes initialSection="pipeline" />, PIPELINE);
    const again = await pipelineSection();
    await waitFor(() => expect(again.querySelectorAll('[data-show^="stage:"]').length).toBeGreaterThan(0));
    expect(within(again).queryByText(t('settings.pipeline.intro.title'))).toBeNull();
  });

  it('still opens the old editor for an admin and closes the panel for it', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="pipeline" />, `${PIPELINE}?show=stage:code_review`);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    const section = await pipelineSection();
    fireEvent.click(within(section).getByRole('button', { name: t('memberEdit.edit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(section).getByRole('button', { name: t('memberEdit.save') })).toBeTruthy();
  });
});

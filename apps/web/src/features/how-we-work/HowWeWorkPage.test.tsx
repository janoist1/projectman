import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { teamRules } from '@projectman/shared';
import { getLocale, standardLabelsFor } from '@projectman/templates';
import { setFetchImplementation } from '../../api/client';
import { applyServerEvent } from '../../api/cache';
import flowStyles from '../../components/flow/Flow.module.css';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { HowWeWorkPage } from './HowWeWorkPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const ADMIN = { can: { manageTeam: true, readConfig: true } };
const VIEWER = { can: { manageTeam: false, readConfig: true } };
const CLIENT = { can: { manageTeam: false, readConfig: false } };

function renderPage(project: ReturnType<typeof mockProject>, route = '/', overrides = ADMIN) {
  return project.render(<HowWeWorkPage />, route, overrides);
}

/** A flow of its own: a column of two steps, a client test, a release, a condition on a card label and a stage without an owner. */
function customFlow(backend: MockBackend) {
  const { pipeline } = backend.config;
  pipeline.columns = [
    { id: 'intake', name: 'Beérkező' },
    { id: 'build', name: 'Munka' },
    { id: 'checks', name: 'Ellenőrzés' },
    { id: 'client', name: 'Ügyfél' },
    { id: 'ship', name: 'Kiadás' },
    { id: 'done', name: 'Kész' },
  ];
  pipeline.labels = [
    ...standardLabelsFor(['design-ok', 'qa-ok'], getLocale('hu')),
    { id: 'ui', name: 'Felületi', meaning: 'A kártya felületet érint.', setBy: 'anyone' },
  ];
  pipeline.stages = [
    { id: 'intake', name: 'Beérkező', kind: 'queue', owners: [], columnId: 'intake' },
    { id: 'build', name: 'Munka', kind: 'work', owners: ['fe-1'], columnId: 'build' },
    {
      id: 'design_check',
      name: 'Terv-ellenőrzés',
      kind: 'step',
      owners: ['qa'],
      columnId: 'checks',
      gate: { conditions: [{ type: 'has_label', label: 'design-ok', when: 'ui' }] },
    },
    { id: 'qa', name: 'Tesztelés', kind: 'step', owners: ['qa'], columnId: 'checks' },
    {
      id: 'client_test',
      name: 'Ügyfélteszt',
      kind: 'step',
      owners: ['kata'],
      columnId: 'client',
      gate: { conditions: [{ type: 'has_label', label: 'qa-ok' }] },
    },
    { id: 'release', name: 'Éles', kind: 'release', owners: ['owner'], columnId: 'ship' },
    { id: 'done', name: 'Kész', kind: 'done', owners: [], columnId: 'done' },
  ];
  backend.syncPermissionViews();
}

function noLabels(backend: MockBackend) {
  const { pipeline } = backend.config;
  pipeline.labels = [];
  for (const stage of pipeline.stages) delete stage.gate;
  backend.syncPermissionViews();
}

function ruleRows() {
  const section = screen.getByRole('region', { name: t('howWeWork.sections.rules') });
  return within(section).getAllByRole('button');
}

describe('how we work page', () => {
  it.each([
    ['admin', ADMIN, true],
    ['developer', VIEWER, false],
    ['viewer', VIEWER, false],
  ] as const)('shows the map to a %s; only an admin gets the way to edit', async (_who, overrides, edits) => {
    const project = mockProject();
    renderPage(project, '/', overrides);
    expect(await screen.findByRole('heading', { level: 1, name: t('howWeWork.title') })).toBeTruthy();
    for (const section of ['flow', 'rules', 'team', 'labels'] as const)
      expect(await screen.findByRole('region', { name: t(`howWeWork.sections.${section}`) })).toBeTruthy();
    expect(!!screen.queryByRole('link', { name: t('howWeWork.editInSettings') })).toBe(edits);
    expect(project.requests.some((request) => request.method !== 'GET')).toBe(false);
  });

  it('shows a client nothing: the page does not exist and no configuration is asked for', () => {
    const project = mockProject();
    renderPage(project, '/', CLIENT);
    expect(screen.getByText(t('app.notFound'))).toBeTruthy();
    expect(project.requests.some((request) => request.path.endsWith('/config'))).toBe(false);
  });

  it('draws a project made from a template', async () => {
    const project = mockProject();
    renderPage(project);
    const flow = within(await screen.findByRole('region', { name: t('howWeWork.sections.flow') }));
    for (const stage of project.backend.config.pipeline.stages)
      expect(flow.getAllByText(stage.name).length).toBeGreaterThan(0);
  });

  it('lists exactly the rules the configuration yields, in order', async () => {
    const project = mockProject();
    renderPage(project);
    await screen.findByRole('region', { name: t('howWeWork.sections.rules') });
    expect(ruleRows().map((row) => row.getAttribute('data-show'))).toEqual(
      teamRules(project.backend.config).map((rule) => `rule:${rule.id}`),
    );
  });

  it('draws a custom flow: shared column, client test, release, a condition and a stage with no owner', async () => {
    const backend = new MockBackend();
    customFlow(backend);
    const project = mockProject(backend);
    renderPage(project);
    const flow = within(await screen.findByRole('region', { name: t('howWeWork.sections.flow') }));
    for (const stage of backend.config.pipeline.stages)
      expect(flow.getAllByText(stage.name).length).toBeGreaterThan(0);
    expect(flow.getAllByText(t('howWeWork.flow.noOwner')).length).toBeGreaterThan(0);
    const ui = backend.config.pipeline.labels.find((label) => label.id === 'ui')!;
    expect(flow.getAllByText(t('howWeWork.flow.when', { name: ui.name })).length).toBeGreaterThan(0);
    expect(ruleRows().map((row) => row.getAttribute('data-show'))).toEqual(
      teamRules(backend.config).map((rule) => `rule:${rule.id}`),
    );
  });

  it('says so when the project has no labels', async () => {
    const backend = new MockBackend();
    noLabels(backend);
    const project = mockProject(backend);
    renderPage(project);
    const labels = within(await screen.findByRole('region', { name: t('howWeWork.sections.labels') }));
    expect(labels.getByText(t('howWeWork.label.none'))).toBeTruthy();
    expect(labels.getByRole('link', { name: t('howWeWork.label.editAll') })).toBeTruthy();
  });

  it('shows a viewer the empty labels without the way to edit them', async () => {
    const backend = new MockBackend();
    noLabels(backend);
    renderPage(mockProject(backend), '/', VIEWER);
    const labels = within(await screen.findByRole('region', { name: t('howWeWork.sections.labels') }));
    expect(labels.getByText(t('howWeWork.label.none'))).toBeTruthy();
    expect(labels.queryByRole('link')).toBeNull();
  });
});

describe('live updates', () => {
  it('shows a changed fix-round limit in the rule and in the loop of the code review', async () => {
    const project = mockProject();
    const view = renderPage(project);
    const before = project.backend.config.team.limits.maxFixRounds ?? 3;
    const flow = within(await screen.findByRole('region', { name: t('howWeWork.sections.flow') }));
    const loop = (limit: number) =>
      flow.queryAllByText(t('howWeWork.flow.loop', { stage: 'Fejlesztés', limit }));
    expect(loop(before).length).toBeGreaterThan(0);

    project.backend.config.team.limits.maxFixRounds = before + 4;
    act(() => {
      applyServerEvent(view.client, { type: 'config_changed', projectKey: 'AC', version: 'live-1' });
    });

    await waitFor(() => expect(loop(before + 4).length).toBeGreaterThan(0));
    expect(loop(before)).toHaveLength(0);
    const rule = ruleRows().find((row) => row.getAttribute('data-show') === 'rule:fix_limit');
    expect(rule?.textContent).toContain(`${before + 4}`);
  });

  it('flashes the stage that changed, for a moment', async () => {
    const project = mockProject();
    const view = renderPage(project);
    await screen.findByRole('region', { name: t('howWeWork.sections.flow') });
    const station = () => document.querySelector('[data-show="stage:qa"]');
    expect(station()?.classList.contains(flowStyles.flash!)).toBe(false);

    const qa = project.backend.config.pipeline.stages.find((stage) => stage.id === 'qa')!;
    qa.owners = ['qa', 'dev-1'];
    act(() => {
      applyServerEvent(view.client, { type: 'config_changed', projectKey: 'AC', version: 'live-2' });
    });
    await waitFor(() => expect(station()?.classList.contains(flowStyles.flash!)).toBe(true));
    expect(document.querySelector('[data-show="stage:dev"]')?.classList.contains(flowStyles.flash!)).toBe(
      false,
    );
    await waitFor(() => expect(station()?.classList.contains(flowStyles.flash!)).toBe(false), {
      timeout: 3000,
    });
  });
});

describe('the item on show', () => {
  it('opens the stage named in ?show= and closes it with Esc, the focus returning to its row', async () => {
    const project = mockProject();
    renderPage(project, '/?show=stage:dev');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('Fejlesztés').length).toBeGreaterThan(0);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('[data-show="stage:dev"]')),
    );
  });

  it('returns the focus to the element that opened it', async () => {
    const project = mockProject();
    renderPage(project);
    const opener = await screen.findByRole('button', { name: t('howWeWork.legendButton') });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('offers the way to edit a stage only to an admin', async () => {
    const admin = mockProject();
    renderPage(admin, '/?show=stage:dev');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: t('howWeWork.stage.editPipeline') })).toBeTruthy();
  });

  it('shows a viewer the stage without the way to edit it', async () => {
    const viewer = mockProject();
    renderPage(viewer, '/?show=stage:dev', VIEWER);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('link', { name: t('howWeWork.stage.editPipeline') })).toBeNull();
  });

  it.each(['stage:vanished', 'member:ghost', 'label:nothing'])('says an item is gone: %s', async (show) => {
    renderPage(mockProject(), `/?show=${show}`);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText(t('howWeWork.gone.title')).length).toBeGreaterThan(0);
  });

  it.each(['member:qa', 'label:qa-ok', 'rule:fix_limit', 'rule:new_card', 'legend'])(
    'opens what ?show=%s names',
    async (show) => {
      renderPage(mockProject(), `/?show=${show}`);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).queryByText(t('howWeWork.gone.title'))).toBeNull();
    },
  );
});

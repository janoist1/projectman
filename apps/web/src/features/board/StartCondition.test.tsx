import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StartCondition } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { onTaskUpdate } from '../../test/msw/tasks';
import { apiFailure } from '../../test/msw/contract';
import { BoardPage } from './BoardPage';
import { startFlags } from './StartCondition';
import { TaskPrioritySelect } from './TaskPriority';

const cardOf = (key: string) => document.querySelector<HTMLElement>(`[data-card-key="${key}"]`)!;

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function setup(condition: unknown = { priority: 'any', hold: ['hold'] }) {
  const project = mockProject();
  project.backend.config.team.startCondition = StartCondition.parse(condition);
  const task = project.backend.findTask('AC-20')!;
  Object.assign(task, {
    stageId: 'ready',
    status: 'active',
    priority: null,
    themeKey: null,
    parentKey: null,
    labels: [],
    archivedAt: null,
  });
  return { project, task, data: { config: project.backend.config, tasks: project.backend.tasks, marks: [] } };
}

describe('start condition board', () => {
  it('uses the same direct controls in the properties panel', async () => {
    const { project, task } = setup();
    project.render(<TaskPrioritySelect task={task} />);
    const choices = await screen.findByRole('group', { name: t('priority.own') });
    fireEvent.click(within(choices).getByRole('button', { name: t('priority.levels.high') }));
    await screen.findByText(t('priority.saved'));
    expect(project.requests).toContainEqual({
      method: 'PATCH',
      path: `/api/projects/AC/tasks/${task.key}`,
      body: { priority: 'high' },
    });
  });

  it('shows a configured inherited hold and label source in the real board', async () => {
    const { project, task } = setup({ labels: ['ui'], hold: ['waiting-answer'] });
    project.backend.config.pipeline.labels.push({ id: 'ui', name: 'Ready to start', setBy: 'anyone' });
    const parent = project.backend.findTask('AC-24')!;
    Object.assign(parent, { labels: ['ui', 'waiting-answer'], status: 'active', archivedAt: null });
    task.parentKey = parent.key;
    project.render(<BoardPage />);
    await screen.findByRole('region', { name: t('board.start.filters') });
    const card = cardOf(task.key);
    expect(within(card).queryByText(t('taskStatus.ready'))).toBeNull();
    expect(card.hasAttribute('data-startable')).toBe(false);
    expect(card.querySelector('[data-startable]')).toBeNull();
    const holdName = project.backend.config.pipeline.labels.find(
      (label) => label.id === 'waiting-answer',
    )!.name;
    expect(within(card).getByText(`Ⅱ ${holdName}`)).toBeTruthy();
    expect(
      within(card).getByText(
        t('board.start.labelSource', {
          labels: project.backend.config.pipeline.labels.find((label) => label.id === 'ui')!.name,
        }),
        { exact: false },
      ),
    ).toBeTruthy();
    expect(within(card).queryByText(`→ ${t('board.start.go')}`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Visszatartva \(/ }));
    expect(cardOf(task.key)).toBeTruthy();
  });

  it('saves a theme priority directly and updates its cards through the same HTTP result', async () => {
    const { project, task } = setup();
    const theme = project.backend.findTask('AC-24')!;
    Object.assign(theme, {
      kind: 'theme',
      priority: null,
      status: 'active',
      archivedAt: null,
      parentKey: null,
      themeKey: null,
    });
    task.themeKey = theme.key;
    project.render(<BoardPage />);
    const tile = (
      await screen.findByRole('button', { name: t('board.themes.open', { title: theme.title }) })
    ).closest('li')!;
    const high = within(tile).getByRole('button', { name: t('priority.levels.high') });
    fireEvent.click(high);
    await waitFor(() => expect(high.getAttribute('aria-pressed')).toBe('true'));
    expect(project.requests).toContainEqual({
      method: 'PATCH',
      path: `/api/projects/AC/tasks/${theme.key}`,
      body: { priority: 'high' },
    });
    const card = cardOf(task.key);
    expect(
      within(card)
        .getByRole('link', { name: t('priority.themeSource', { key: theme.key, title: theme.title }) })
        .getAttribute('href'),
    ).toBe(`/p/AC/tasks/${theme.key}`);
    expect(within(card).getByText(`→ ${t('board.start.go')}`)).toBeTruthy();
  });

  it('saves directly from an idea, updates the HTTP result and restores focus when it leaves the list', async () => {
    const { project, task } = setup();
    project.render(<BoardPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Ötletek \(/ }));
    const card = cardOf(task.key);
    expect(within(card).getByText(`○ ${t('board.start.idea')}`)).toBeTruthy();
    expect(within(card).queryByText(t('taskStatus.ready'))).toBeNull();
    expect(card.querySelector('[data-startable]')).toBeNull();
    const high = within(card).getByRole('button', { name: t('priority.levels.high') });
    high.focus();
    fireEvent.click(high);
    await waitFor(() => expect(project.backend.findTask(task.key)!.priority).toBe('high'));
    await waitFor(() => expect(cardOf(task.key)).toBeNull());
    expect(project.requests).toContainEqual({
      method: 'PATCH',
      path: `/api/projects/AC/tasks/${task.key}`,
      body: { priority: 'high' },
    });
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-pressed')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /^Minden \(/ }));
    const updated = cardOf(task.key);
    expect(
      within(updated)
        .getByRole('button', { name: t('priority.levels.high') })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(updated).getByText(`→ ${t('board.start.go')}`)).toBeTruthy();
  });

  it('keeps a weaker own priority, shows its stronger parent source and preserves inheritance after clearing', async () => {
    const { project, task } = setup();
    const parent = project.backend.findTask('AC-24')!;
    Object.assign(parent, { priority: 'high', status: 'active', archivedAt: null });
    Object.assign(task, { priority: 'low', parentKey: parent.key });
    project.render(<BoardPage />);
    const source = await screen.findByRole('link', {
      name: t('priority.parentSource', { key: parent.key, title: parent.title }),
    });
    const card = source.closest('[data-card-key]') as HTMLElement;
    expect(source.getAttribute('href')).toBe(`/p/AC/tasks/${parent.key}`);
    expect(
      within(card)
        .getByRole('button', { name: t('priority.levels.low') })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(within(card).getByRole('button', { name: t('priority.clear') }));
    await waitFor(() => expect(task.priority).toBeNull());
    expect(
      within(card).getByText(t('priority.effective', { level: t('priority.levels.high') }), { exact: false }),
    ).toBeTruthy();
    expect(within(card).getByText(`→ ${t('board.start.go')}`)).toBeTruthy();
  });

  it('retains the previous selection on failure and retries the same request locally', async () => {
    const { project, task } = setup();
    task.priority = 'normal';
    onTaskUpdate(task.key, apiFailure(500, 'unexpected_failure'));
    project.render(<BoardPage />);
    await screen.findByRole('button', { name: /^Minden \(/ });
    const card = cardOf(task.key);
    const urgent = within(card).getByRole('button', { name: t('priority.levels.urgent') });
    urgent.focus();
    fireEvent.click(urgent);
    await within(card).findByRole('alert');
    expect(
      within(card)
        .getByRole('button', { name: t('priority.levels.normal') })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(urgent));
    onTaskUpdate(task.key, ({ body }) => project.backend.updateTask(task.key, { priority: body.priority })!);
    fireEvent.click(within(card).getByRole('button', { name: t('priority.retry') }));
    await within(card).findByText(t('priority.saved'));
    expect(
      within(card)
        .getByRole('button', { name: t('priority.levels.urgent') })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('refreshes the grace indicator at the server deadline even when the marks response is unchanged', async () => {
    const { project, task } = setup();
    task.priority = 'high';
    const fetch = createMockFetch(project.backend, project.requests);
    const marks = {
      marks: [
        {
          taskKey: task.key,
          metSince: new Date().toISOString(),
          dueAt: new Date(Date.now() + 700).toISOString(),
        },
      ],
    };
    let reads = 0;
    setFetchImplementation((path, init) => {
      if (!path.endsWith('/start-condition-marks')) return fetch(path, init);
      reads += 1;
      return Promise.resolve(new Response(JSON.stringify(marks), { status: 200 }));
    });
    project.render(<BoardPage />);
    await screen.findByText(t('board.start.gracePending'));
    await waitFor(() => expect(screen.queryByText(t('board.start.gracePending'))).toBeNull());
    expect(reads).toBeGreaterThan(1);
  });

  it('uses only server marks for grace, excluding urgent cards', async () => {
    const { project, task } = setup();
    task.priority = 'high';
    const fetch = createMockFetch(project.backend, project.requests);
    setFetchImplementation((path, init) =>
      path.endsWith('/start-condition-marks')
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                marks: [
                  {
                    taskKey: task.key,
                    metSince: new Date().toISOString(),
                    dueAt: new Date(Date.now() + 60_000).toISOString(),
                  },
                ],
              }),
              { status: 200 },
            ),
          )
        : fetch(path, init),
    );
    project.render(<BoardPage />);
    const grace = await screen.findByText(t('board.start.gracePending'));
    const card = grace.closest('[data-card-key]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: t('priority.levels.urgent') }));
    await waitFor(() => expect(within(card).queryByText(t('board.start.gracePending'))).toBeNull());
  });

  it('shows no new controls without a condition, including for urgent cards', async () => {
    const { project, task } = setup();
    delete project.backend.config.team.startCondition;
    task.priority = 'urgent';
    project.render(<BoardPage />);
    await waitFor(() => expect(cardOf(task.key)).toBeTruthy());
    expect(screen.queryByRole('region', { name: t('board.start.filters') })).toBeNull();
    expect(screen.queryByRole('group', { name: t('priority.own') })).toBeNull();
    expect(project.requests.some((request) => request.path.endsWith('/start-condition-marks'))).toBe(false);
  });

  it('renders read-only effective values without editors', async () => {
    const { project, task } = setup();
    task.priority = 'high';
    project.render(<BoardPage />, '/', { can: { createTasks: false } });
    await screen.findByRole('button', { name: /^Minden \(/ });
    const card = cardOf(task.key);
    expect(
      within(card).getByText(t('priority.effective', { level: t('priority.levels.high') })),
    ).toBeTruthy();
    expect(within(card).queryByRole('group')).toBeNull();
  });

  it('follows label and combined conditions, inherited holds and work already underway', () => {
    const { project, task, data } = setup({
      labels: ['go'],
      priority: 'high',
      combine: 'all',
      hold: ['later'],
    });
    const parent = project.backend.findTask('AC-24')!;
    Object.assign(parent, { labels: ['go'], priority: 'high', status: 'active', archivedAt: null });
    task.parentKey = parent.key;
    expect(startFlags(task, data)).toEqual({ go: true, ideas: false, held: false });
    parent.labels.push('later');
    expect(startFlags(task, data)).toEqual({ go: false, ideas: false, held: true });
    parent.priority = null;
    expect(startFlags(task, data)).toEqual({ go: false, ideas: true, held: true });
    task.stageId = 'dev';
    expect(startFlags(task, data).ideas).toBe(false);
    data.config.team.startCondition = StartCondition.parse({ labels: ['go'], hold: [] });
    task.stageId = 'ready';
    expect(startFlags(task, data).go).toBe(true);
  });
});

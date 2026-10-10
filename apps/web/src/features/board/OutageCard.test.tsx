import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import type { Task, WorkOutage } from '@projectman/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { outageReason, outageStuckLabel, outageStuckTitle } from '../../lib/outage';
import { deriveTaskState, groupOpenInboxByTask } from '../../lib/taskState';
import type { TaskStateContext } from '../../lib/taskState';
import { inbox, tasks } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { mockIndexes, renderUi } from '../../test/render';
import { TaskCard } from './TaskCard';
import { TaskDrawer } from './TaskDrawer';

/** A card that stands on an outage (PM-468): "Áll: …" on the card and in the drawer. */

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const since = '2026-10-08T08:00:00.000Z';
const ENGINE = { id: 'eng_abcdefghijkl', name: 'Mac mini' };
const claude: WorkOutage = {
  kind: 'provider',
  id: 'out_claude',
  provider: 'claude',
  problem: 'not_logged_in',
  engine: null,
  since,
};
const engine: WorkOutage = { kind: 'engine', id: 'out_engine', engine: ENGINE, since };

const { pipeline, members } = mockIndexes();
const ctx: TaskStateContext = {
  pipeline,
  members,
  openInboxByTask: groupOpenInboxByTask(inbox),
  tasksByKey: new Map(tasks.map((task) => [task.key, task])),
  myHandle: 'owner',
};

function renderCard(task: Task) {
  renderUi(<TaskCard task={task} state={deriveTaskState(task, ctx)} pipeline={pipeline} to="/task" />);
  return screen.getByRole('link');
}

describe('the board card of a stuck card', () => {
  it('says why it stands, in orange, with what to do as the tooltip', () => {
    const card = renderCard({ ...tasks.find((task) => task.key === 'AC-24')!, outage: claude });

    expect(card.getAttribute('data-phase')).toBe('stuck');
    const line = screen.getByText(outageStuckLabel(claude));
    expect(line.textContent).toBe(t('taskStatus.stuck', { reason: outageReason(claude) }));
    expect(line.getAttribute('title')).toBe(outageStuckTitle(claude));
  });

  it('names the engine that does not connect', () => {
    const card = renderCard({ ...tasks.find((task) => task.key === 'AC-24')!, outage: engine });

    expect(card.getAttribute('data-phase')).toBe('stuck');
    expect(screen.getByText(t('taskStatus.stuck', { reason: outageReason(engine) })).textContent).toContain(
      ENGINE.name,
    );
  });

  it('is the same for a card that is not waiting to start but would continue', () => {
    const task: Task = { ...tasks.find((entry) => entry.key === 'AC-24')!, status: 'active', outage: claude };
    expect(task.startWaiting).toBeUndefined();
    expect(renderCard(task).getAttribute('data-phase')).toBe('stuck');
    expect(screen.getByText(outageStuckLabel(claude))).toBeTruthy();
  });

  it('is gone from the card once the outage is', () => {
    expect(renderCard(tasks.find((task) => task.key === 'AC-24')!).getAttribute('data-phase')).not.toBe(
      'stuck',
    );
  });
});

describe('the drawer of a stuck card', () => {
  const drawer = (
    <Routes>
      <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
    </Routes>
  );

  it('heads the login box with the same line and keeps the command', async () => {
    const project = mockProject();
    project.backend.startOutage(claude, ['be-1'], ['AC-20']);
    project.render(drawer, '/p/AC/tasks/AC-20');

    const box = (await screen.findByTestId('drawer-outage')) as HTMLElement;
    expect(box.textContent).toContain(outageStuckLabel(claude));
    expect(box.textContent).toContain(t('providerSettings.loginCommands.claude'));
    expect(box.textContent).toContain(t('inbox.alerts.work_outage.todo.login'));
  });

  it('sends the person to the machine of a remote engine', async () => {
    const project = mockProject();
    project.backend.startOutage({ ...claude, engine: ENGINE }, ['be-1'], ['AC-20']);
    project.render(drawer, '/p/AC/tasks/AC-20');

    const box = (await screen.findByTestId('drawer-outage')) as HTMLElement;
    expect(box.textContent).toContain(
      t('inbox.alerts.work_outage.todo.loginOnEngine', { engine: ENGINE.name }),
    );
  });
});

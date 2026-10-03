import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopDecisionOf } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

/** The loop watch of a card in the fake backend and in the "Rád vár" list (PM-261). */

const loopItems = (backend: MockBackend) => backend.inbox.filter((item) => loopDecisionOf(item) !== null);

/** `count` messages between two AI members of the fake team, alternating who writes. */
const chat = (backend: MockBackend, count: number, taskKey = 'AC-21') => {
  for (let i = 0; i < count; i++) {
    const [from, to] = i % 2 === 0 ? ['fe-1', 'code-review'] : ['code-review', 'fe-1'];
    backend.addTimeline(taskKey, from!, 'team_message', { messageId: `m${taskKey}${i}`, from, to: [to] });
  }
};

function backendWithWatch(count = 3) {
  const backend = new MockBackend();
  backend.config.team.limits.loopWatch = { enabled: true, count, minutes: 30 };
  return backend;
}

/** The fake team has no project manager: this makes Devops the holder of the scheduling duty. */
function giveSchedulingToDevops(backend: MockBackend) {
  const devops = backend.config.team.members.find((member) => member.handle === 'devops');
  if (devops?.kind === 'ai') devops.role = 'project_manager';
}

describe('the loop watch in the fake backend', () => {
  it('goes to the owner as a decision when nobody holds the scheduling duty, once per loop', () => {
    const backend = backendWithWatch();
    chat(backend, 2);
    expect(backend.findTask('AC-21')?.loop).toBeUndefined();
    chat(backend, 1);
    expect(backend.findTask('AC-21')?.loop).toMatchObject({
      phase: 'owner',
      ownerReason: 'no_watcher',
      count: 3,
      members: ['code-review', 'fe-1'],
      deciders: ['owner'],
    });
    expect(loopItems(backend)).toMatchObject([
      {
        kind: 'decision',
        assignees: ['owner'],
        taskKey: 'AC-21',
        state: 'open',
        options: [{ id: 'stop_work' }, { id: 'let_run' }],
      },
    ]);
    chat(backend, 3);
    expect(loopItems(backend)).toHaveLength(1);
  });

  it('tells the scheduling holder first, and goes to the owner only when it went on after that', () => {
    const backend = backendWithWatch();
    giveSchedulingToDevops(backend);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      chat(backend, 3);
      expect(backend.findTask('AC-21')?.loop).toMatchObject({ phase: 'notified', notified: 'devops' });
      expect(loopItems(backend)).toEqual([]);
      // Only what is written after the notice counts as "went on".
      vi.advanceTimersByTime(60_000);
      chat(backend, 3);
      expect(backend.findTask('AC-21')?.loop).toMatchObject({ phase: 'owner', ownerReason: 'continued' });
      expect(loopDecisionOf(loopItems(backend)[0]!)).toMatchObject({
        reason: 'continued',
        watcher: 'devops',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count what people write, and is off when switched off', () => {
    const backend = backendWithWatch();
    for (let i = 0; i < 5; i++)
      backend.addTimeline('AC-21', 'owner', 'team_message', {
        messageId: `p${i}`,
        from: 'owner',
        to: ['fe-1'],
      });
    expect(backend.findTask('AC-21')?.loop).toBeUndefined();
    backend.config.team.limits.loopWatch = { enabled: false, count: 3, minutes: 30 };
    chat(backend, 6);
    expect(backend.findTask('AC-21')?.loop).toBeUndefined();
  });

  it('ends with a label change, closes its decision by itself, and counts again from there', () => {
    const backend = backendWithWatch();
    chat(backend, 3);
    expect(loopItems(backend)[0]).toMatchObject({ state: 'open' });
    backend.addTimeline('AC-21', 'owner', 'task_labels_changed', { added: ['qa-ok'], removed: [] });
    expect(backend.findTask('AC-21')?.loop).toBeUndefined();
    expect(loopItems(backend)[0]).toMatchObject({
      state: 'resolved',
      resolution: { by: 'system', rule: 'loop_ended' },
    });
    expect(backend.timeline.at(-1)).toMatchObject({
      type: 'task_loop',
      data: { phase: 'ended', endReason: 'label' },
    });
  });
});

describe('a loop on screen', () => {
  const render = (project: ReturnType<typeof mockProject>) =>
    project.render(
      <ToastProvider>
        <InboxPage />
      </ToastProvider>,
      '/p/AC/inbox',
    );

  it('shows the decision with what each button leads to, and "Hadd fusson" leaves the mark on', async () => {
    const project = mockProject(backendWithWatch());
    chat(project.backend, 3);
    const item = loopItems(project.backend)[0]!;
    render(project);

    const card = (await screen.findByRole('heading', { name: t('inbox.loop.heading') })).closest('article')!;
    expect(within(card).getByText(t('inbox.kinds.decision'))).toBeTruthy();
    // It comes from the system, not from a member: the head says so instead of showing an empty avatar.
    expect(within(card).getByText(t('common.system'))).toBeTruthy();
    expect(card.textContent).toContain('AC-21');
    expect(card.textContent).toContain(t('inbox.loop.reasons.no_watcher'));
    expect(within(card).getByText(t('inbox.loop.consequence.stop_work'))).toBeTruthy();
    expect(within(card).getByText(t('inbox.loop.consequence.let_run'))).toBeTruthy();
    expect(within(card).getByText(t('inbox.loop.footer'))).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.let_run') }));
    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: `/api/projects/AC/inbox/${item.id}/resolve`,
        body: { optionId: 'let_run' },
      }),
    );
    expect(await screen.findByText(t('inbox.loop.toast.let_run'))).toBeTruthy();
    expect(project.backend.findTask('AC-21')?.loop).toMatchObject({ phase: 'let_run', letRunBy: 'owner' });
  });

  it('stops the card\'s work with "Leállítom a munkát", and the mark goes', async () => {
    const project = mockProject(backendWithWatch());
    chat(project.backend, 3);
    render(project);
    const card = (await screen.findByRole('heading', { name: t('inbox.loop.heading') })).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.stop_work') }));
    expect(await screen.findByText(t('inbox.loop.toast.stop_work', { key: 'AC-21' }))).toBeTruthy();
    expect(project.backend.findTask('AC-21')?.loop).toBeUndefined();
    expect(project.backend.timeline.at(-1)).toMatchObject({
      data: { phase: 'ended', endReason: 'stopped', by: 'owner' },
    });
  });

  it('lists a decision the loop closed by itself in the history, without a button', async () => {
    const project = mockProject(backendWithWatch());
    chat(project.backend, 3);
    project.backend.addTimeline('AC-21', 'owner', 'task_labels_changed', { added: ['qa-ok'], removed: [] });
    render(project);
    await screen.findByText(t('inbox.recent'));
    expect(screen.queryByRole('heading', { name: t('inbox.loop.heading') })).toBeNull();
    expect(screen.getByText(new RegExp(t('inbox.resolutions.loop_ended')))).toBeTruthy();
    expect(screen.getByText(t('inbox.loop.subject', { key: 'AC-21' }))).toBeTruthy();
  });
});

describe('a message storm alert from before the loop watch', () => {
  it('keeps its text and its "Láttam" button', async () => {
    const project = mockProject();
    const alert: InboxItem = {
      id: 'inb_old_burst',
      projectKey: 'AC',
      kind: 'alert',
      assignees: ['owner'],
      source: 'fe-1',
      sessionId: null,
      taskKey: 'AC-21',
      title: '10 messages and notes on AC-21 in 15 minutes',
      body: null,
      payload: {
        alert: 'message_burst',
        taskKey: 'AC-21',
        count: 10,
        minutes: 15,
        members: ['owner', 'fe-1'],
        at: new Date().toISOString(),
      },
      options: [{ id: 'seen', label: 'seen', style: 'primary' }],
      state: 'open',
      resolution: null,
      createdAt: new Date().toISOString(),
    };
    project.backend.inbox.push(alert);
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = (
      await screen.findByRole('heading', { name: t('inbox.alerts.message_burst.heading') })
    ).closest('article')!;
    expect(card.textContent).toMatch(/AC-21.*15.*10/);
    expect(within(card).getByRole('button', { name: t('inbox.options.seen') })).toBeTruthy();
  });
});

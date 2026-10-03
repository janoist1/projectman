import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { fixLimitDecisionOf } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { TaskDrawer } from '../board/TaskDrawer';
import { InboxPage } from './InboxPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

/** The upper limit on a card's fix rounds in the fake backend and on screen (PM-262). */

const fixItems = (backend: MockBackend) => backend.inbox.filter((item) => fixLimitDecisionOf(item) !== null);

/** `count` change requests of the code review on a card, one label event each. */
const changeRequests = (backend: MockBackend, count: number, taskKey = 'AC-21') => {
  for (let i = 0; i < count; i++)
    backend.addTimeline(taskKey, 'code-review', 'task_labels_changed', {
      added: ['code-review-changes'],
      removed: [],
    });
};

function setRole(backend: MockBackend, handle: string, role: 'lead_developer' | 'architect') {
  const member = backend.config.team.members.find((candidate) => candidate.handle === handle);
  if (member?.kind === 'ai') member.role = role;
}

/** A team with a lead developer (decides first) and, when asked, another technical member (plans). */
function backendWith({ lead = false, planner = false } = {}) {
  const backend = new MockBackend();
  backend.config.team.limits.maxFixRounds = 2;
  if (lead) setRole(backend, 'code-review', 'lead_developer');
  if (planner) setRole(backend, 'devops', 'architect');
  return backend;
}

describe('the fix round limit in the fake backend', () => {
  it('holds a card at the limit and gives the decision to the lead developer', () => {
    const backend = backendWith({ lead: true });
    changeRequests(backend, 1);
    expect(backend.findTask('AC-21')?.fixLimit).toBeUndefined();
    changeRequests(backend, 1);
    expect(backend.findTask('AC-21')?.fixLimit).toMatchObject({
      phase: 'lead',
      decider: 'code-review',
      rounds: 2,
      limit: 2,
      changeRequests: 2,
    });
    expect(fixItems(backend)).toEqual([]);
    expect(backend.timeline.at(-1)).toMatchObject({
      type: 'task_fix_limit',
      data: { phase: 'reached', rounds: 2, limit: 2, decider: 'code-review' },
    });
  });

  it('goes to the owner at once when no AI member can decide, with the buttons that apply', () => {
    const backend = backendWith();
    changeRequests(backend, 2);
    expect(backend.findTask('AC-21')?.fixLimit).toMatchObject({ phase: 'owner', reason: 'no_ai_decider' });
    // Nobody to write a plan, but another developer can take the card.
    expect(fixItems(backend)).toMatchObject([
      { assignees: ['owner'], state: 'open', options: [{ id: 'reassign' }, { id: 'another_round' }] },
    ]);

    const withPlanner = backendWith({ planner: true });
    changeRequests(withPlanner, 2);
    expect(fixItems(withPlanner)[0]?.options.map((option) => option.id)).toEqual([
      'replan',
      'reassign',
      'another_round',
    ]);
  });

  it('lets the lead give one more round, and goes to the owner when the limit is reached again', () => {
    const backend = backendWith({ lead: true });
    changeRequests(backend, 2);
    backend.decideFixLimit('AC-21', 'continue', 'The last findings are small.');
    expect(backend.findTask('AC-21')?.fixLimit).toBeUndefined();
    expect(backend.timeline.at(-1)).toMatchObject({
      type: 'task_fix_limit',
      data: { phase: 'ended', endReason: 'decided' },
    });
    expect(
      backend.timeline.map((event) => event.data).filter((data) => data.phase === 'decided'),
    ).toMatchObject([{ decision: 'another_round', by: 'code-review', note: 'The last findings are small.' }]);

    // The round it got counts: the card is held again at the next change request.
    changeRequests(backend, 1);
    expect(backend.findTask('AC-21')?.fixLimit).toMatchObject({
      phase: 'owner',
      reason: 'again',
      rounds: 3,
      limit: 3,
    });
  });

  it('passes the card on to the owner when the lead says so, with the reason', () => {
    const backend = backendWith({ lead: true });
    changeRequests(backend, 2);
    backend.decideFixLimit('AC-21', 'to_owner', 'The plan itself is wrong.');
    expect(backend.findTask('AC-21')?.fixLimit).toMatchObject({ phase: 'owner', reason: 'passed_on' });
    expect(fixLimitDecisionOf(fixItems(backend)[0]!)).toMatchObject({
      reason: 'passed_on',
      decider: 'code-review',
      note: 'The plan itself is wrong.',
    });
  });

  it('ends the hold and closes the decision when the card goes to somebody else', () => {
    const backend = backendWith();
    changeRequests(backend, 2);
    backend.addTimeline('AC-21', 'owner', 'task_assigned', { assignee: 'be-1', previous: 'fe-1' });
    expect(backend.findTask('AC-21')?.fixLimit).toBeUndefined();
    expect(fixItems(backend)[0]).toMatchObject({
      state: 'resolved',
      resolution: { by: 'system', rule: 'fix_limit_ended' },
    });
    expect(backend.timeline.at(-1)).toMatchObject({
      type: 'task_fix_limit',
      data: { phase: 'ended', endReason: 'assignee_changed' },
    });
    // The count starts again for the new assignee.
    changeRequests(backend, 1);
    expect(backend.findTask('AC-21')?.fixLimit).toBeUndefined();
  });

  it('does not hold a card that is on a human, or that nobody counts the rounds of', () => {
    const backend = backendWith();
    const task = backend.findTask('AC-21')!;
    backend.updateTask('AC-21', { assignee: 'owner' });
    changeRequests(backend, 3);
    expect(task.fixLimit).toBeUndefined();
    expect(fixItems(backend)).toEqual([]);
  });
});

describe('a held card on screen', () => {
  const drawer = (
    <Routes>
      <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
    </Routes>
  );

  it('shows who decides in the status line, the box and the rounds of the usage', async () => {
    const project = mockProject(backendWith({ lead: true }));
    changeRequests(project.backend, 2);
    project.render(drawer, '/p/AC/tasks/AC-21');

    const box = (await screen.findByRole('heading', { name: t('fixLimit.box.title') })).closest('section')!;
    expect(box.textContent).toContain(t('fixLimit.box.lead', { name: 'Code review' }));
    // Only the kinds of round that happened are named, and the count stands at the right.
    expect(box.textContent).toContain(t('fixLimit.part.changes', { count: 2 }));
    expect(box.textContent).not.toContain('UI/UX');
    expect(box.textContent).toContain(t('fixLimit.box.count', { rounds: 2, limit: 2 }));
    // The first row of the rounds, at the limit.
    const row = screen.getByText(t('tokenUsage.fixRounds')).closest('div')!;
    expect(row.textContent).toContain(t('tokenUsage.fixRoundsValue', { rounds: 2, limit: 2 }));
    expect(row.parentElement?.firstElementChild).toBe(row);
  });

  it('shows the decision, not the box, to the person who is asked to decide', async () => {
    const project = mockProject(backendWith());
    changeRequests(project.backend, 2);
    project.render(drawer, '/p/AC/tasks/AC-21');
    await screen.findByRole('heading', { name: t('inbox.fixLimit.heading'), level: 3 });
    expect(screen.queryByRole('heading', { name: t('fixLimit.box.title') })).toBeNull();
  });

  it('shows no box and no hold once the card has gone on', async () => {
    const project = mockProject(backendWith({ lead: true }));
    changeRequests(project.backend, 2);
    project.backend.decideFixLimit('AC-21', 'continue', 'One more.');
    project.render(drawer, '/p/AC/tasks/AC-21');
    await screen.findByText(t('tokenUsage.fixRounds'));
    expect(screen.queryByRole('heading', { name: t('fixLimit.box.title') })).toBeNull();
  });
});

describe('the decision of a held card in the inbox', () => {
  const render = (project: ReturnType<typeof mockProject>) =>
    project.render(
      <ToastProvider>
        <InboxPage />
      </ToastProvider>,
      '/p/AC/inbox',
    );

  it('shows what each button leads to, and "Még egy kör" lets the card go on', async () => {
    const project = mockProject(backendWith());
    changeRequests(project.backend, 2);
    const item = fixItems(project.backend)[0]!;
    render(project);

    const card = (await screen.findByRole('heading', { name: t('inbox.fixLimit.heading') })).closest(
      'article',
    )!;
    expect(within(card).getByText(t('common.system'))).toBeTruthy();
    expect(card.textContent).toContain('AC-21');
    expect(card.textContent).toContain(t('inbox.fixLimit.reasons.no_ai_decider'));
    expect(card.textContent).toContain(t('fixLimit.part.changes', { count: 2 }));
    expect(within(card).getByText(t('inbox.fixLimit.consequence.reassign'))).toBeTruthy();
    expect(within(card).getByText(t('inbox.fixLimit.consequence.another_round'))).toBeTruthy();
    // Nobody can write a plan in this team, so there is no such button.
    expect(within(card).queryByRole('button', { name: t('inbox.options.replan') })).toBeNull();
    expect(within(card).getByText(t('inbox.fixLimit.footer'))).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.another_round') }));
    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: `/api/projects/AC/inbox/${item.id}/resolve`,
        body: { optionId: 'another_round' },
      }),
    );
    expect(await screen.findByText(t('inbox.fixLimit.toast.another_round', { key: 'AC-21' }))).toBeTruthy();
    expect(project.backend.findTask('AC-21')?.fixLimit).toBeUndefined();
  });

  it('gives the card to another developer with "Másik megvalósító"', async () => {
    const project = mockProject(backendWith({ planner: true }));
    changeRequests(project.backend, 2);
    render(project);
    const card = (await screen.findByRole('heading', { name: t('inbox.fixLimit.heading') })).closest(
      'article',
    )!;
    expect(within(card).getByRole('button', { name: t('inbox.options.replan') })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.reassign') }));
    expect(await screen.findByText(t('inbox.fixLimit.toast.reassign', { key: 'AC-21' }))).toBeTruthy();
    expect(project.backend.findTask('AC-21')).toMatchObject({ assignee: 'be-1', fixLimit: undefined });
  });

  it('asks the planner with "Pontosabb tervet kérek", and the card stays held until it decides', async () => {
    const project = mockProject(backendWith({ planner: true }));
    changeRequests(project.backend, 2);
    render(project);
    const card = (await screen.findByRole('heading', { name: t('inbox.fixLimit.heading') })).closest(
      'article',
    )!;
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.replan') }));
    expect(await screen.findByText(t('inbox.fixLimit.toast.replan', { key: 'AC-21' }))).toBeTruthy();
    expect(project.backend.findTask('AC-21')?.fixLimit).toMatchObject({ phase: 'replan', decider: 'devops' });
  });

  it('lists a decision the card closed by itself in the history, without a button', async () => {
    const project = mockProject(backendWith());
    changeRequests(project.backend, 2);
    project.backend.addTimeline('AC-21', 'owner', 'task_assigned', { assignee: 'be-1', previous: 'fe-1' });
    render(project);
    await screen.findByText(t('inbox.recent'));
    expect(screen.queryByRole('heading', { name: t('inbox.fixLimit.heading') })).toBeNull();
    expect(screen.getByText(new RegExp(t('inbox.resolutions.fix_limit_ended')))).toBeTruthy();
    expect(screen.getByText(t('inbox.fixLimit.subject', { key: 'AC-21' }))).toBeTruthy();
    // The system raised it: the line names "Rendszer", not the raw source.
    expect(
      screen.getByText(`${t('inbox.resolutions.fix_limit_ended')} · ${t('common.system')} · AC-21`),
    ).toBeTruthy();
  });
});

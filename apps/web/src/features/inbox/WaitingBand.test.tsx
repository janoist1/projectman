import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TODO_CANNOT_OPTION, TODO_DONE_OPTION } from '@projectman/shared';
import type { InboxItem, ScreeningWaitReason } from '@projectman/shared';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function waiting(
  id: string,
  since: string,
  reason: ScreeningWaitReason = 'on_leave',
  overdue = false,
): InboxItem {
  return {
    id,
    projectKey: 'AC',
    kind: 'question',
    assignees: ['owner'],
    source: 'dev-1',
    sessionId: null,
    taskKey: 'AC-22',
    title: `Kérdés ${id}`,
    body: null,
    payload: {
      question: `Kérdés ${id}`,
      screening: { until: since, waiting: { since, reason, ...(overdue ? { overdue } : {}) } },
    },
    options: [],
    state: 'screening',
    resolution: null,
    createdAt: since,
  };
}

/** An open integrator todo: it waits for the connected Claude, not for the screening. */
function integratorTodo(id: string): InboxItem {
  const at = hoursAgo(2);
  return {
    ...waiting(id, at),
    state: 'open',
    options: [TODO_DONE_OPTION, TODO_CANNOT_OPTION],
    payload: {
      question: 'Futtasd le',
      recipient: 'integrator',
      integratorOpenedAt: at,
      screening: {
        until: at,
        at,
        outcome: 'todo',
        todo: { what: 'Futtasd le', where: 'Mac', expected: 'Kimenet', recipient: 'integrator' },
      },
    },
  };
}

function renderInbox(
  items: InboxItem[],
  overrides?: Parameters<ReturnType<typeof mockProject>['render']>[2],
) {
  const project = mockProject(new MockBackend());
  project.backend.inbox = items;
  project.render(
    <ToastProvider>
      <InboxPage />
    </ToastProvider>,
    '/p/AC/inbox',
    overrides,
  );
  return project;
}

const band = () => screen.queryByRole('region', { name: t('inbox.waiting.title') });

describe('the "waiting for others" band on the inbox (PM-1252)', () => {
  it('is absent when nothing waits for anyone else, and for a person who is not an owner', async () => {
    renderInbox([], { isOwner: false });
    await screen.findByText(t('inbox.allDoneEverywhere'));
    expect(band()).toBeNull();
  });

  it('says how many questions wait and since when, and opens to the rows with a way to take them over', async () => {
    renderInbox([waiting('inb_new', hoursAgo(1)), waiting('inb_old', hoursAgo(30), 'paused', true)]);

    const region = await screen.findByRole('region', { name: t('inbox.waiting.title') });
    expect(region.querySelector('summary')?.textContent).toContain('2');
    fireEvent.click(region.querySelector('summary')!);
    const rows = within(region).getAllByRole('listitem');
    // Oldest first, and a late one says so.
    expect(rows[0]!.textContent).toContain('Kérdés inb_old');
    expect(rows[0]!.textContent).toContain(t('inbox.waiting.overdue'));
    expect(rows[1]!.textContent).toContain(t('inbox.waiting.chip'));
    expect(
      within(rows[1]!).getByRole('button', {
        name: t('inbox.waiting.pullFor', { subject: 'Kérdés inb_new' }),
      }),
    ).toBeTruthy();
  });

  it('shows machine todos alone as a plain row that does not open', async () => {
    renderInbox([integratorTodo('inb_todo')]);

    const region = await screen.findByRole('region', { name: t('inbox.waiting.title') });
    expect(region.querySelector('details')).toBeNull();
    expect(within(region).queryByRole('button')).toBeNull();
  });

  it('takes a question over: posts the pull, thanks with a toast and moves the question into the list', async () => {
    const project = renderInbox([waiting('inb_new', hoursAgo(1))]);
    const region = await screen.findByRole('region', { name: t('inbox.waiting.title') });
    fireEvent.click(region.querySelector('summary')!);

    fireEvent.click(within(region).getByRole('button', { name: /^Átveszem|^Take over/ }));

    await waitFor(() =>
      expect(project.requests.some((request) => request.path.endsWith('/inbox/inb_new/pull'))).toBe(true),
    );
    expect(await screen.findByText(t('inbox.waiting.pulled'))).toBeTruthy();
    // The band is gone with its last row, the question is a card of the owner now.
    await waitFor(() => expect(band()).toBeNull());
    expect((await screen.findByText('Kérdés inb_new')).closest('article')).toBeTruthy();
  });

  it('says the project manager was faster when the question is not waiting any more', async () => {
    const project = renderInbox([waiting('inb_new', hoursAgo(1))]);
    const region = await screen.findByRole('region', { name: t('inbox.waiting.title') });
    fireEvent.click(region.querySelector('summary')!);
    // Meanwhile the project manager settled it; the page does not know yet.
    const stored = project.backend.inbox.find((item) => item.id === 'inb_new')!;
    stored.state = 'resolved';

    fireEvent.click(within(region).getByRole('button', { name: /^Átveszem|^Take over/ }));

    const answer = await screen.findByRole('status', { name: '' });
    expect(answer.textContent).toBe(t('inbox.waiting.alreadyHandled'));
    // The pull button is gone: the keyboard focus moves to the answer and the row no longer says it waits.
    expect(document.activeElement).toBe(answer);
    expect(within(region).queryByText(t('inbox.waiting.chip'))).toBeNull();
    expect(project.requests.some((request) => request.path.endsWith('/inbox/inb_new/pull'))).toBe(true);
  });
});

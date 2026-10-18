import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TODO_DONE_OPTION, TODO_CANNOT_OPTION, routes, questionPayloadOf } from '@projectman/shared';
import type { InboxItem, BoardView } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { patchOpenInboxCount } from '../../api/cache';
import { queryKeys } from '../../api/queryKeys';
import { QueryClient } from '@tanstack/react-query';
import { plainLanguageQuestion } from '../../mocks/fixtures';
import { mockProject } from '../../test/mockProject';
import { inboxItemDomId, isRecentDecision, openItemsFor, openItemIds, resolutionNote } from '../../lib/inbox';
import { t } from '../../i18n/t';
import { InboxPage } from './InboxPage';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function todo(id = 'inb_integrator', hoursAgo = 3): InboxItem {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return {
    ...plainLanguageQuestion(),
    id,
    title: 'Measure latency',
    assignees: ['owner'],
    state: 'open',
    resolution: null,
    options: [TODO_DONE_OPTION, TODO_CANNOT_OPTION],
    payload: {
      question: 'Measure latency',
      recipient: 'integrator',
      integratorOpenedAt: at,
      screening: {
        until: at,
        outcome: 'todo',
        todo: { what: 'Measure latency', where: 'Hub', expected: 'Result', recipient: 'integrator' },
      },
    },
  };
}

describe('quiet integrator todos in the owner inbox', () => {
  it('keeps an externally closed edited card in the integrator group without adding a human task', async () => {
    const project = mockProject();
    const item = todo();
    project.backend.inbox = [item];
    const view = project.render(<InboxPage />, '/p/AC/inbox');
    const summary = (await screen.findByText(t('inbox.integrator.titleCount', { count: 1 }))).closest(
      'summary',
    )!;
    fireEvent.click(summary);
    const details = summary.closest('details')!;
    const input = within(details).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Unsent measurement' } });
    const closed: InboxItem = {
      ...item,
      state: 'resolved',
      resolution: {
        by: 'owner',
        via: 'integrator',
        integratorTodo: true,
        at: new Date().toISOString(),
        optionId: 'todo_done',
        note: 'Measured elsewhere',
      },
    };
    act(() => view.client.setQueryData(queryKeys.inbox('AC'), { items: [closed] }));
    expect(await within(details).findByRole('status')).toBeTruthy();
    expect(details.querySelector('article')).not.toBeNull();
    expect(screen.getByText(t('inbox.allDoneEverywhere'))).toBeTruthy();
    expect(openItemsFor([closed], 'owner')).toHaveLength(0);
  });
  it('patches the websocket board count only after a persisted handoff', () => {
    const project = mockProject();
    const client = new QueryClient();
    const item = todo();
    client.setQueryData(queryKeys.me, project.context.me);
    client.setQueryData(
      queryKeys.board('AC'),
      project.backend.handle('GET', routes.board('AC'), undefined).body,
    );
    patchOpenInboxCount(client, 'AC', { items: [item] });
    expect(client.getQueryData<BoardView>(queryKeys.board('AC'))?.openInboxCount).toBe(0);
    const moved = {
      ...item,
      payload: { ...item.payload, recipient: 'owner', integratorEscalatedAt: new Date().toISOString() },
    };
    patchOpenInboxCount(client, 'AC', { items: [moved] });
    expect(client.getQueryData<BoardView>(queryKeys.board('AC'))?.openInboxCount).toBe(1);
    client.clear();
  });
  it('keeps the owner list empty and puts the todo in a keyboard accessible, initially folded group', async () => {
    const project = mockProject();
    project.backend.inbox = [todo()];
    project.render(<InboxPage />, '/p/AC/inbox');
    expect(await screen.findByText(t('inbox.allDoneEverywhere'))).toBeTruthy();
    const summary = screen.getByText(t('inbox.integrator.titleCount', { count: 1 })).closest('summary')!;
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    summary.focus();
    expect(document.activeElement).toBe(summary);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(within(details).getByText(t('inbox.integrator.lead'))).toBeTruthy();
    expect(details.querySelector('article')?.getAttribute('data-recipient')).toBe('integrator');
    expect(
      within(details).getByText(
        t('inbox.integrator.left', { left: t('inbox.integrator.hours', { count: 21 }) }),
      ),
    ).toBeTruthy();
    expect(openItemsFor(project.backend.inbox, 'owner')).toHaveLength(0);
    expect(openItemIds(project.backend.inbox).size).toBe(0);
    expect(project.backend.handle('GET', routes.board('AC'), undefined).body).toMatchObject({
      openInboxCount: 0,
    });
  });

  it('uses the shared rule in fake mine reads and hides integrator origin from every non-owner', () => {
    const project = mockProject();
    project.backend.inbox = [todo()];
    expect(
      project.backend.handle('GET', routes.inbox('AC'), undefined, new URLSearchParams('mine=true')).body,
    ).toMatchObject({ items: [] });
    for (const access of ['admin', 'developer', 'client', 'viewer'] as const) {
      const viewer = project.backend.config.team.members.find((m) => m.kind === 'human')!;
      if (viewer.kind !== 'human') throw new Error('missing human');
      viewer.access = access;
      project.backend.members.find((m) => m.handle === viewer.handle)!.role = access;
      expect(project.backend.handle('GET', routes.inbox('AC'), undefined).body).toMatchObject({ items: [] });
    }
  });

  it('orders by integrator opening, shows only five results from the local day, and distinguishes own work from relay', async () => {
    const project = mockProject();
    const closed = Array.from({ length: 7 }, (_, index): InboxItem => ({
      ...todo(`inb_closed_${index}`),
      title: `Closed ${index}`,
      payload: {
        ...todo().payload,
        screening: {
          until: new Date().toISOString(),
          outcome: 'todo',
          todo: { what: `Closed ${index}`, where: 'Hub', expected: 'Result', recipient: 'integrator' },
        },
      },
      state: 'resolved',
      resolution: {
        optionId: 'todo_done',
        by: 'owner',
        via: 'integrator',
        integratorTodo: true,
        at: new Date(Date.now() - index * 60_000).toISOString(),
        note: `Result ${index}`,
      },
    }));
    project.backend.inbox = [todo('newer', 1), todo('older', 6), ...closed];
    project.render(<InboxPage />, '/p/AC/inbox');
    const summary = (await screen.findByText(t('inbox.integrator.titleCount', { count: 2 }))).closest(
      'summary',
    )!;
    fireEvent.click(summary);
    const details = summary.closest('details')!;
    expect([...details.querySelectorAll('article')].map((node) => node.id)).toEqual([
      inboxItemDomId('older'),
      inboxItemDomId('newer'),
    ]);
    expect(within(details).getAllByText(/^Megcsinálta:/)).toHaveLength(5);
    expect(within(details).queryByText('Result 6')).toBeNull();
    expect(screen.queryByText(t('inbox.recent'))).toBeNull();
    expect(isRecentDecision(closed[0]!)).toBe(false);
    expect(resolutionNote(closed[0]!)).toBe(t('inbox.integrator.resultNote', { note: 'Result 0' }));
  });

  it('moves the expired todo to the owner list from the persisted fake sweep and never moves a young one', async () => {
    const project = mockProject();
    const old = todo('expired', 24);
    const young = todo('young', 23);
    project.backend.inbox = [old, young];
    project.backend.sweepIntegratorTodos(new Date().toISOString());
    expect(questionPayloadOf(project.backend.inbox.find((i) => i.id === old.id)!)).toMatchObject({
      recipient: 'owner',
      integratorEscalatedAt: expect.any(String),
    });
    expect(openItemsFor(project.backend.inbox, 'owner').map((i) => i.id)).toEqual(['expired']);
    expect(project.backend.handle('GET', routes.board('AC'), undefined).body).toMatchObject({
      openInboxCount: 1,
    });
    project.render(<InboxPage />, '/p/AC/inbox');
    expect(await screen.findByText(t('inbox.integrator.moved'))).toBeTruthy();
    expect(screen.getByText(t('inbox.integrator.titleCount', { count: 1 }))).toBeTruthy();
  });

  it('lets the owner resolve in place and keeps the original recipient in their history', async () => {
    const project = mockProject();
    project.backend.inbox = [todo()];
    project.render(<InboxPage />, '/p/AC/inbox');
    const summary = (await screen.findByText(t('inbox.integrator.titleCount', { count: 1 }))).closest(
      'summary',
    )!;
    fireEvent.click(summary);
    fireEvent.click(
      within(summary.closest('details')!).getByRole('button', { name: t('inbox.options.todo_done') }),
    );
    await waitFor(() => expect(project.backend.inbox[0]!.state).toBe('resolved'));
    expect(project.backend.inbox[0]!.resolution?.integratorTodo).toBeUndefined();
    expect(await screen.findByText(new RegExp(t('inbox.integrator.wasForIntegrator')))).toBeTruthy();
  });

  it.each(['todo_done', 'todo_cannot'] as const)(
    'attributes the owner %s result to the owner in the closed group',
    async (optionId) => {
      const project = mockProject();
      const item: InboxItem = {
        ...todo(),
        state: 'resolved',
        resolution: {
          optionId,
          by: 'owner',
          at: new Date().toISOString(),
          note: 'Owner result',
        },
      };
      project.backend.inbox = [item];
      project.render(<InboxPage />, '/p/AC/inbox');
      const summary = (await screen.findByText(t('inbox.integrator.title'))).closest('summary')!;
      fireEvent.click(summary);
      const group = within(summary.closest('details')!);
      expect(
        group.getByText(
          t(optionId === 'todo_done' ? 'inbox.integrator.doneByYou' : 'inbox.integrator.cannotByYou', {
            what: 'Measure latency',
          }),
        ),
      ).toBeTruthy();
      expect(
        group.getByText(
          t(optionId === 'todo_done' ? 'inbox.integrator.yourNote' : 'inbox.integrator.reasonNote', {
            note: 'Owner result',
          }),
        ),
      ).toBeTruthy();
      expect(group.queryByText(t('inbox.integrator.resultNote', { note: 'Owner result' }))).toBeNull();
    },
  );
});

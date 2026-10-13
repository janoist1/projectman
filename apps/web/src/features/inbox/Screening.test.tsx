import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TODO_CANNOT_OPTION, TODO_DONE_OPTION } from '@projectman/shared';
import type { InboxItem, QuestionCloseRule, QuestionScreening } from '@projectman/shared';
import { applyServerEvent } from '../../api/cache';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const NOTE = 'A staging eléréséhez a te kulcsod kell.';

/** The cards on the page (the history rows are no cards) that mention a text. */
const cardsWith = (text: string) =>
  screen.queryAllByRole('article').filter((card) => card.textContent?.includes(text));

/** A kind's filter pill: its name is the label with the count after it. */
const pill = (kind: 'todo' | 'permission') =>
  screen.queryByRole('button', { name: new RegExp(`^${t(`inbox.kinds.${kind}`)}`) });

function question(id: string, overrides: Partial<InboxItem> = {}, screening?: QuestionScreening): InboxItem {
  const title = `Kérdés ${id}`;
  return {
    id,
    projectKey: 'AC',
    kind: 'question',
    assignees: ['owner'],
    source: 'dev-1',
    sessionId: null,
    taskKey: 'AC-22',
    title,
    body: null,
    payload: { question: title, ...(screening ? { screening } : {}) },
    options: [],
    state: 'open',
    resolution: null,
    createdAt: minutesAgo(30),
    ...overrides,
  };
}

/** A question the Operator made a todo of: the step, its note, and the two todo buttons. */
function todo(id = 'inb_todo', overrides: Partial<InboxItem> = {}): InboxItem {
  return question(
    id,
    { options: [TODO_DONE_OPTION, TODO_CANNOT_OPTION], ...overrides },
    {
      until: minutesAgo(20),
      outcome: 'todo',
      by: 'operator',
      at: minutesAgo(25),
      note: NOTE,
      todo: { what: 'Futtasd le a migrációt', where: 'A staging szerveren', expected: 'Hibátlan kimenet' },
    },
  );
}

function closed(item: InboxItem, rule: QuestionCloseRule, by = 'system'): InboxItem {
  return {
    ...item,
    state: 'cancelled',
    resolution: { optionId: 'closed', by, at: minutesAgo(1), note: null, rule },
  };
}

function renderInbox(
  items: InboxItem[],
  overrides?: Parameters<ReturnType<typeof mockProject>['render']>[2],
) {
  const project = mockProject(new MockBackend());
  project.backend.inbox = items;
  const view = project.render(
    <ToastProvider>
      <InboxPage />
    </ToastProvider>,
    '/p/AC/inbox',
    overrides,
  );
  return { ...project, client: view.client };
}

describe('a todo of the Operator in the inbox (PM-561)', () => {
  it('is a kind of its own: the step, the Operator note, a pill, and a group of its own next to the decisions', async () => {
    renderInbox([
      question('inb_other', { options: [{ id: 'yes', label: 'Igen', style: 'primary' }] }),
      todo(),
    ]);
    const card = (await screen.findByText('Kérdés inb_todo')).closest('article')!;
    expect(card.getAttribute('data-kind')).toBe('todo');
    expect(within(card).getByText(t('inbox.todo.stepTitle'))).toBeTruthy();
    expect(within(card).getByText('Futtasd le a migrációt')).toBeTruthy();
    expect(within(card).getByText('A staging szerveren')).toBeTruthy();
    expect(within(card).getByText(NOTE)).toBeTruthy();
    expect(within(card).getByText(t('inbox.todo.resultOptional'))).toBeTruthy();
    // No "Küldés": the two buttons are the answer.
    expect(within(card).getByRole('button', { name: t('inbox.options.todo_done') })).toBeTruthy();
    expect(within(card).getByRole('button', { name: t('inbox.options.todo_cannot') })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: t('inbox.answerSubmit') })).toBeNull();

    expect(
      screen.getByRole('heading', { level: 2, name: new RegExp(t('inbox.groups.decisions')) }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: new RegExp(t('inbox.groups.todo')) })).toBeTruthy();
    expect(screen.getByText(t('inbox.groups.todoHint'))).toBeTruthy();
    expect(pill('todo')).toBeTruthy();
  });

  it('shows no group headings or pills for kinds with nothing waiting', async () => {
    renderInbox([todo()]);
    await screen.findByText('Kérdés inb_todo');
    expect(screen.queryByText(t('inbox.groups.todoHint'))).toBeNull();
    expect(pill('permission')).toBeNull();
  });

  it('"Megcsináltam" resolves with the optional result, and the todo filter then says there is nothing left', async () => {
    const project = renderInbox([
      todo(),
      question('inb_other', { options: [{ id: 'yes', label: 'Igen', style: 'primary' }] }),
    ]);
    await screen.findByText('Kérdés inb_todo');
    fireEvent.click(pill('todo')!);
    const card = (await screen.findByText('Kérdés inb_todo')).closest('article')!;
    fireEvent.change(within(card).getByRole('textbox'), { target: { value: 'Lefutott, 12 sor' } });
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.todo_done') }));
    await waitFor(() =>
      expect(
        project.requests.find((request) => request.path.endsWith('/inbox/inb_todo/resolve'))?.body,
      ).toEqual({
        optionId: 'todo_done',
        note: 'Lefutott, 12 sor',
      }),
    );
    expect(await screen.findByText(t('inbox.todo.emptyFilter'))).toBeTruthy();
  });

  it('"Nem tudom megcsinálni" needs a reason: without it nothing is sent and the card asks for it', async () => {
    const project = renderInbox([todo()]);
    const card = (await screen.findByText('Kérdés inb_todo')).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.todo_cannot') }));
    expect((await within(card).findByRole('alert')).textContent).toBe(t('inbox.todo.reasonRequired'));
    expect(project.requests.some((request) => request.path.endsWith('/resolve'))).toBe(false);

    fireEvent.change(within(card).getByRole('textbox'), { target: { value: 'Nincs hozzáférésem' } });
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.todo_cannot') }));
    await waitFor(() =>
      expect(project.requests.find((request) => request.path.endsWith('/resolve'))?.body).toEqual({
        optionId: 'todo_cannot',
        note: 'Nincs hozzáférésem',
      }),
    );
  });

  it('lists a todo the viewer could not do among the decisions as refused, not as done', async () => {
    renderInbox([
      {
        ...todo(),
        state: 'resolved',
        resolution: { optionId: 'todo_cannot', by: 'owner', at: minutesAgo(2), note: 'Nincs hozzáférésem' },
      },
    ]);
    const list = (await screen.findByRole('heading', { name: t('inbox.recent') })).closest('section')!;
    expect(within(list).getByText(new RegExp(t('inbox.resolutions.todo_cannot')))).toBeTruthy();
    expect(within(list).getByText('Nincs hozzáférésem')).toBeTruthy();
  });
});

describe('the history of closed questions (PM-561)', () => {
  it('says why a question closed without an answer, and keeps the Operator-settled ones out', async () => {
    renderInbox([
      closed(question('inb_a'), 'task_done'),
      closed(question('inb_b'), 'handed_off', 'dev-1'),
      // The Operator settled these itself: they belong to its trail, not to the viewer's history.
      closed(question('inb_c', {}, { until: minutesAgo(5), outcome: 'moot' }), 'operator_moot', 'operator'),
      {
        ...question('inb_d', {}, { until: minutesAgo(5), outcome: 'answered' }),
        state: 'resolved',
        resolution: {
          optionId: 'answer',
          by: 'operator',
          at: minutesAgo(3),
          note: 'Igen',
          rule: 'operator_answered',
        },
      },
    ]);
    const list = (await screen.findByRole('heading', { name: t('inbox.recent') })).closest('section')!;
    expect(within(list).getByText(new RegExp(t('inbox.resolutions.task_done')))).toBeTruthy();
    expect(within(list).getByText(new RegExp(t('inbox.resolutions.handed_off')))).toBeTruthy();
    // Nobody answered: a card finishing is not a person's decision.
    expect(within(list).getByText(new RegExp(t('inbox.closedBySystem')))).toBeTruthy();
    expect(within(list).queryByText(new RegExp(t('inbox.resolutions.operator_moot')))).toBeNull();
    expect(within(list).queryByText('Kérdés inb_c')).toBeNull();
    expect(within(list).queryByText('Kérdés inb_d')).toBeNull();
  });

  it('lists a question the Operator released and closed as moot, because it had gone to the people', async () => {
    renderInbox([
      closed(
        question('inb_e', {}, { until: minutesAgo(15), fallback: 'timeout' }),
        'operator_moot',
        'operator',
      ),
    ]);
    const list = (await screen.findByRole('heading', { name: t('inbox.recent') })).closest('section')!;
    expect(within(list).getByText(new RegExp(t('inbox.resolutions.operator_moot')))).toBeTruthy();
  });

  it('says the answer waits for the member to start, and when it reached them', async () => {
    const answered = (id: string, payload: Record<string, unknown>): InboxItem => ({
      ...question(id),
      payload: { question: `Kérdés ${id}`, ...payload },
      state: 'resolved',
      resolution: { optionId: 'answer', by: 'owner', at: minutesAgo(4), note: 'Igen' },
    });
    renderInbox([
      answered('inb_w', {
        answerDelivery: { state: 'waiting', reason: 'member_on_leave', since: minutesAgo(4) },
      }),
      answered('inb_x', { answerDelivery: { state: 'delivered', at: minutesAgo(1) } }),
    ]);
    const list = (await screen.findByRole('heading', { name: t('inbox.recent') })).closest('section')!;
    expect(within(list).getByText(new RegExp(t('inbox.awaitsStart.after.leave')))).toBeTruthy();
    expect(within(list).getByText(new RegExp('^Megkapta '))).toBeTruthy();
  });
});

describe('the answer waits for the member to start (PM-561)', () => {
  const asked = () =>
    question('inb_s', {
      options: [{ id: 'yes', label: 'Igen', style: 'primary' }],
      askerStart: { reason: 'member_on_leave' },
    });

  it('says it above the buttons, and the notice after the answer repeats it', async () => {
    const project = renderInbox([asked()]);
    const card = (await screen.findByText('Kérdés inb_s')).closest('article')!;
    expect(within(card).getByText(new RegExp(t('inbox.awaitsStart.before.leave')))).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Igen' }));
    await waitFor(() =>
      expect(project.requests.some((request) => request.path.endsWith('/resolve'))).toBe(true),
    );
    expect(
      await screen.findByText(new RegExp(`Elküldve\\..*${t('inbox.awaitsStart.before.leave')}`)),
    ).toBeTruthy();
  });
});

describe('a question that closes while it is open (PM-561)', () => {
  it('keeps a half-typed answer in a notice with the reason, until "Rendben"', async () => {
    const project = renderInbox([todo()]);
    const card = (await screen.findByText('Kérdés inb_todo')).closest('article')!;
    fireEvent.change(within(card).getByRole('textbox'), { target: { value: 'félig kész válasz' } });
    act(() =>
      applyServerEvent(project.client, {
        type: 'inbox_upserted',
        projectKey: 'AC',
        item: closed(todo(), 'task_done'),
      }),
    );
    const notice = (
      await screen.findByText(
        t('inbox.closedWhileOpen.withReason', { reason: t('inbox.closedReasons.task_done') }),
      )
    ).closest('[role="status"]')!;
    fireEvent.click(
      within(notice as HTMLElement).getByRole('button', { name: t('inbox.closedWhileOpen.dismiss') }),
    );
    await waitFor(() => expect(cardsWith('inb_todo')).toHaveLength(0), { timeout: 2000 });
  });

  it('disappears quietly when nothing was typed in it', async () => {
    const project = renderInbox([
      todo(),
      question('inb_other', { options: [{ id: 'yes', label: 'Igen', style: 'primary' }] }),
    ]);
    await screen.findByText('Kérdés inb_todo');
    act(() =>
      applyServerEvent(project.client, {
        type: 'inbox_upserted',
        projectKey: 'AC',
        item: closed(todo(), 'task_done'),
      }),
    );
    // The notice mounts for a moment and dismisses itself: wait until it has settled.
    await waitFor(() => expect(cardsWith('inb_todo')).toHaveLength(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(cardsWith('inb_todo')).toHaveLength(0);
    expect(cardsWith('inb_other')).toHaveLength(1);
    expect(screen.queryByText(/Ez a kérdés közben lezárult/)).toBeNull();
  });

  it('refuses the answer of a question that closed meanwhile, and says so on its card', async () => {
    const project = renderInbox([
      question('inb_q', { options: [{ id: 'yes', label: 'Igen', style: 'primary' }] }),
    ]);
    const card = (await screen.findByText('Kérdés inb_q')).closest('article')!;
    // The server closed it; this page has not heard yet.
    project.backend.inbox = [
      closed(
        question('inb_q', { options: [{ id: 'yes', label: 'Igen', style: 'primary' }] }),
        'withdrawn',
        'dev-1',
      ),
    ];
    fireEvent.click(within(card).getByRole('button', { name: 'Igen' }));
    expect(
      await screen.findByText(
        t('inbox.closedWhileOpen.withReason', { reason: t('inbox.closedReasons.withdrawn') }),
      ),
    ).toBeTruthy();
    // No generic failure toast on top of the notice.
    expect(screen.queryByText(t('inbox.resolveFailed'))).toBeNull();
  });
});

describe('"Az Operátor intézte" (PM-561)', () => {
  const settled = (
    id: string,
    screening: QuestionScreening,
    overrides: Partial<InboxItem> = {},
  ): InboxItem => ({
    ...question(id, {}, screening),
    state: 'resolved',
    resolution: {
      optionId: 'answer',
      by: 'operator',
      at: minutesAgo(10),
      note: 'Igen',
      rule: 'operator_answered',
    },
    ...overrides,
  });
  const trailItems = () => [
    settled('inb_t1', { until: minutesAgo(40), outcome: 'answered', note: 'A terv szerint igen' }),
    settled(
      'inb_t2',
      { until: minutesAgo(40), outcome: 'forwarded', forwardedTo: 'dev', note: 'Ez a fejlesztőre tartozik' },
      {
        resolution: {
          optionId: 'forwarded',
          by: 'operator',
          at: minutesAgo(8),
          note: null,
          rule: 'operator_forwarded',
        },
      },
    ),
    {
      ...question(
        'inb_t3',
        { state: 'screening' },
        { until: new Date(Date.now() + 5 * 60_000).toISOString() },
      ),
    },
  ];

  it("is a folded row with the day's count; opened, it lists what the Operator settled and holds", async () => {
    const project = renderInbox(trailItems());
    const summary = await screen.findByText(t('inbox.operatorTrail.title', { count: 3 }));
    expect(project.requests.some((request) => request.path.includes('/inbox/screened?since='))).toBe(true);
    const fold = summary.closest('details')!;
    expect(fold.open).toBe(false);
    expect(within(fold).getByText(t('inbox.operatorTrail.lead'))).toBeTruthy();
    expect(within(fold).getByText('Kérdés inb_t1')).toBeTruthy();
    expect(within(fold).getByText('A terv szerint igen')).toBeTruthy();
    expect(within(fold).getByText(t('inbox.operatorTrail.answered'))).toBeTruthy();
    expect(within(fold).getByText(t('inbox.operatorTrail.forwarded'))).toBeTruthy();
    expect(within(fold).getByText(t('inbox.operatorTrail.at'))).toBeTruthy();
    // The question the Operator still holds is not in the viewer's list.
    expect(screen.queryByRole('article', { name: /inb_t3/ })).toBeNull();
  });

  it('is not shown when nothing was screened today', async () => {
    renderInbox([question('inb_plain', { options: [{ id: 'yes', label: 'Igen', style: 'primary' }] })]);
    await screen.findByText('Kérdés inb_plain');
    expect(screen.queryByText(t('inbox.operatorTrail.titleUnknown'))).toBeNull();
    expect(screen.queryByText(/Az Operátor intézte/)).toBeNull();
  });

  it('is not asked for, nor shown, to someone who cannot manage the team', async () => {
    const project = renderInbox(trailItems(), { can: { manageTeam: false } });
    await screen.findByText(t('inbox.title'));
    await waitFor(() =>
      expect(project.requests.some((request) => request.path.includes('/inbox?'))).toBe(true),
    );
    expect(project.requests.some((request) => request.path.includes('/inbox/screened'))).toBe(false);
    expect(screen.queryByText(/Az Operátor intézte/)).toBeNull();
  });

  it("says how many of the day's are shown when there are more than the list holds", async () => {
    const many = Array.from({ length: 22 }, (_, index) =>
      settled(`inb_m${index}`, { until: minutesAgo(40), outcome: 'answered' }),
    );
    renderInbox(many);
    const summary = await screen.findByText(t('inbox.operatorTrail.title', { count: 22 }));
    expect(
      within(summary.closest('details')!).getByText(t('inbox.operatorTrail.limit', { count: 20 })),
    ).toBeTruthy();
  });

  it('keeps the count when the list cannot be read, with a way to try again', async () => {
    const project = mockProject(new MockBackend());
    project.backend.inbox = trailItems();
    const handle = project.backend.handle.bind(project.backend);
    let failing = true;
    vi.spyOn(project.backend, 'handle').mockImplementation((method, path, body, query) =>
      failing && path.endsWith('/inbox/screened')
        ? { status: 500, body: { error: { code: 'internal_error', message: 'boom' } } }
        : handle(method, path, body, query),
    );
    project.render(
      <ToastProvider>
        <InboxPage />
      </ToastProvider>,
      '/p/AC/inbox',
    );
    const summary = await screen.findByText(t('inbox.operatorTrail.titleUnknown'));
    const fold = summary.closest('details')!;
    fold.open = true;
    fireEvent(fold, new Event('toggle'));
    expect(await within(fold).findByText(t('inbox.operatorTrail.error'))).toBeTruthy();
    failing = false;
    fireEvent.click(within(fold).getByRole('button', { name: t('inbox.operatorTrail.retry') }));
    expect(await screen.findByText(t('inbox.operatorTrail.title', { count: 3 }))).toBeTruthy();
  });
});

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router';
import { getLocale } from '@projectman/templates';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { MessagesPage } from './MessagesPage';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

/** The page on its three routes, with the current address on show. */
function Pages() {
  return (
    <>
      <Routes>
        <Route path="/p/:projectKey/messages" element={<MessagesPage />} />
        <Route path="/p/:projectKey/messages/with/:handle" element={<MessagesPage />} />
        <Route path="/p/:projectKey/messages/all" element={<MessagesPage />} />
      </Routes>
      <Where />
    </>
  );
}

const where = () => screen.getByTestId('where').textContent;

function phone(mobile: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: mobile,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }));
}

function asDeveloper(p: ReturnType<typeof mockProject>) {
  p.backend.viewerHandle = 'kata';
  const me = { ...p.context.me, projects: [{ ...p.context.me.projects[0]!, access: 'developer' as const }] };
  return { me, myHandle: 'kata', can: { createTasks: true, manageTeam: false, workInSessions: true } };
}

const readRequests = (p: ReturnType<typeof mockProject>) =>
  p.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages/read'));

describe('the conversation list', () => {
  it('lists the conversations of the viewer only, with the unread count, and the other members apart', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['owner'], 'AC-21', 'Acme first');
    p.backend.sendTeamMessage('fe-1', ['owner'], 'AC-21', 'Acme second');
    p.backend.sendTeamMessage('qa', ['kata'], null, 'Third party secret');
    p.render(<Pages />, '/p/AC/messages');
    const nav = await screen.findByRole('navigation', { name: t('messages.list.label') });
    const row = await within(nav).findByRole('link', {
      name: new RegExp(`${t('messages.list.unreadCount', { count: 2 })}`),
    });
    expect(row.getAttribute('href')).toBe('/p/AC/messages/with/fe-1');
    expect(within(row).getByText('Acme second')).toBeTruthy();
    // QA wrote to Kata only: not the viewer's conversation, so no row with a preview of it.
    expect(screen.queryByText('Third party secret')).toBeNull();
    expect(within(nav).getByRole('heading', { name: t('messages.list.others') })).toBeTruthy();
    // On a wide screen the latest conversation is open beside the list.
    expect(await screen.findByRole('region', { name: /Beszélgetés:/ })).toBeTruthy();
  });

  it('puts a member who only asked a question into the list', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.render(<Pages />, '/p/AC/messages');
    const nav = await screen.findByRole('navigation', { name: t('messages.list.label') });
    const row = await within(nav).findByRole('link', { name: new RegExp(t('messages.list.asksYou')) });
    expect(row.getAttribute('href')).toBe('/p/AC/messages/with/dev-1');
    expect(within(row).getByText(t('messages.list.asks'))).toBeTruthy();
  });
});

describe('a conversation', () => {
  it('shows a message to several recipients with who else got it, in each recipient thread', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('owner', ['fe-1', 'kata'], 'AC-21', 'Acme to both');
    const first = p.render(<Pages />, '/p/AC/messages/with/fe-1');
    const thread = await screen.findByRole('region', { name: /Beszélgetés:/ });
    expect(await within(thread).findByText('Acme to both')).toBeTruthy();
    expect(within(thread).getByText(/Címzett még: Kata/)).toBeTruthy();
    expect(within(thread).getByRole('button', { name: t('messages.thread.replyAll') })).toBeTruthy();
    first.unmount();
    p.render(<Pages />, '/p/AC/messages/with/kata');
    const other = await screen.findByRole('region', { name: /Beszélgetés:/ });
    expect(await within(other).findByText('Acme to both')).toBeTruthy();
    expect(within(other).getByText(/Címzett még: /)).toBeTruthy();
  });

  it('shows the task chip at the first message and where the task changes', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('owner', ['fe-1'], 'AC-21', 'About twenty-one');
    p.backend.sendTeamMessage('fe-1', ['owner'], 'AC-21', 'Still twenty-one');
    p.backend.sendTeamMessage('owner', ['fe-1'], 'AC-22', 'Now twenty-two');
    p.render(<Pages />, '/p/AC/messages/with/fe-1');
    const log = await screen.findByRole('log');
    await within(log).findByText('Now twenty-two');
    expect(
      within(log)
        .getAllByRole('link', { name: /AC-2[12]/ })
        .map((a) => a.textContent),
    ).toEqual([expect.stringContaining('AC-21'), expect.stringContaining('AC-22')]);
  });

  it('reads the incoming messages in one request after a moment and keeps the new-messages line', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['owner'], null, 'Acme unread one');
    p.backend.sendTeamMessage('fe-1', ['owner'], null, 'Acme unread two');
    p.render(<Pages />, '/p/AC/messages/with/fe-1');
    const log = await screen.findByRole('log');
    await within(log).findByText('Acme unread two');
    expect(readRequests(p)).toHaveLength(0);
    await waitFor(() => expect(readRequests(p)).toHaveLength(1), { timeout: 3000 });
    expect((readRequests(p)[0]!.body as { ids: string[] }).ids).toHaveLength(2);
    await waitFor(() =>
      expect(p.backend.messages.every((m) => m.receipts?.find((r) => r.handle === 'owner')?.readAt)).toBe(
        true,
      ),
    );
    // The marker of this visit stays although the messages are read now.
    expect(within(log).getByText(t('messages.thread.newMessages'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('messages.read') })).toBeNull();
  });

  it('does not read while the tab is hidden', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['owner'], null, 'Acme unseen');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    p.render(<Pages />, '/p/AC/messages/with/fe-1');
    await within(await screen.findByRole('log')).findByText('Acme unseen');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(readRequests(p)).toHaveLength(0);
  });

  it('sends the typed text to the member of the thread with the chosen task', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['owner'], 'AC-21', 'Acme question');
    p.render(<Pages />, '/p/AC/messages/with/fe-1');
    const thread = await screen.findByRole('region', { name: /Beszélgetés:/ });
    await within(thread).findByText('Acme question');
    // The task defaults to the thread's latest one.
    expect((within(thread).getByLabelText(t('messages.composer.task')) as HTMLSelectElement).value).toBe(
      'AC-21',
    );
    fireEvent.change(
      within(thread).getByLabelText(t('messages.composer.label', { name: 'Frontend fejlesztő' })),
      {
        target: { value: 'Acme answer' },
      },
    );
    fireEvent.click(within(thread).getByRole('button', { name: t('common.send') }));
    await waitFor(() =>
      expect(p.backend.messages.at(-1)).toMatchObject({
        from: 'owner',
        to: ['fe-1'],
        taskKey: 'AC-21',
        body: 'Acme answer',
      }),
    );
    expect(await within(thread).findByText('Acme answer')).toBeTruthy();
  });

  it('shows an open question of the member in the thread and answers it there', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.render(<Pages />, '/p/AC/messages/with/dev-1');
    const heading = await screen.findByRole('region', { name: t('messages.question.heading') });
    // Only questions: the permission, gate and alert items stay in the inbox.
    expect(within(heading).getAllByRole('button').length).toBeGreaterThan(0);
    fireEvent.click(await within(heading).findByRole('button', { name: 'Kell GA4 is' }));
    await waitFor(() =>
      expect(p.requests.some((r) => r.method === 'POST' && r.path.endsWith('/inbox/inb_q_ga4/resolve'))).toBe(
        true,
      ),
    );
    expect(await screen.findByText(t('messages.question.answered', { answer: 'Kell GA4 is' }))).toBeTruthy();
  });

  it('opens the reply dialog for everyone of a group message', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['owner', 'kata'], 'AC-21', 'Acme group question');
    p.render(<Pages />, '/p/AC/messages/with/fe-1');
    fireEvent.click(await screen.findByRole('button', { name: t('messages.thread.replyAll') }));
    const dialog = screen.getByRole('dialog');
    expect(
      (within(dialog).getByRole('checkbox', { name: /Frontend fejlesztő/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect((within(dialog).getByRole('checkbox', { name: /Kata/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText(new RegExp(t('messages.task'))) as HTMLSelectElement).value).toBe(
      'AC-21',
    );
  });

  it('shows the delivery of a sent message per recipient, with where it went', async () => {
    const p = mockProject();
    p.backend.messages = [];
    const message = p.backend.sendTeamMessage('owner', ['fe-1', 'qa', 'kata'], 'AC-21', 'Acme delivery');
    message.receipts = [
      { handle: 'fe-1', kind: 'ai', deliveredAt: null, readAt: null },
      {
        handle: 'qa',
        kind: 'ai',
        deliveredAt: message.createdAt,
        readAt: null,
        route: { type: 'task', taskKey: 'AC-2' },
      },
      { handle: 'kata', kind: 'human', deliveredAt: message.createdAt, readAt: message.createdAt },
    ];
    p.render(<Pages />, '/p/AC/messages/with/qa');
    const thread = await screen.findByRole('region', { name: /Beszélgetés:/ });
    await within(thread).findByText('Acme delivery');
    fireEvent.click(within(thread).getByRole('button', { name: t('messages.status.queued') }));
    const details = await screen.findByRole('list', { name: t('messages.status.details') });
    expect(within(details).getByText(new RegExp(t('messages.status.aiQueued')))).toBeTruthy();
    expect(within(details).getByText(new RegExp(t('messages.status.aiTyped')))).toBeTruthy();
    expect(within(details).getByText(new RegExp(t('messages.status.humanRead')))).toBeTruthy();
    expect(
      within(details).getByText(t('messages.routeTask', { taskKey: 'AC-2' }), { exact: false }),
    ).toBeTruthy();
  });

  it('says when to turn to each recipient while choosing them', async () => {
    const p = mockProject();
    p.render(<Pages />, '/p/AC/messages');
    fireEvent.click(await screen.findByRole('button', { name: t('messages.new') }));
    const dialog = within(screen.getByRole('dialog'));
    const qa = getLocale('hu').roles.qa.whenToAsk;
    const recipient = await dialog.findByRole('checkbox', { name: new RegExp(qa.slice(0, 20)) });
    expect(recipient.closest('label')?.textContent).toContain(`${t('roleCatalogue.whenToAsk')}: ${qa}`);
  });

  it('sends a multi-recipient message with an optional task from the new-message dialog', async () => {
    const p = mockProject();
    p.render(<Pages />, '/p/AC/messages');
    fireEvent.click(await screen.findByRole('button', { name: t('messages.new') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /Kata/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /fe-1|Frontend fejlesztő/ }));
    fireEvent.change(within(dialog).getByLabelText(t('messages.text')), {
      target: { value: 'Acme delivery discussion' },
    });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('messages.task'))), {
      target: { value: 'AC-21' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('messages.send') }));
    await waitFor(() =>
      expect(p.backend.messages.at(-1)).toMatchObject({
        to: ['kata', 'fe-1'],
        taskKey: 'AC-21',
        from: 'owner',
      }),
    );
  });

  it('shows a viewer the conversations without a composer', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['owner'], null, 'Acme for a viewer');
    const me = { ...p.context.me, projects: [{ ...p.context.me.projects[0]!, access: 'viewer' as const }] };
    p.render(<Pages />, '/p/AC/messages/with/fe-1', { me });
    await within(await screen.findByRole('log')).findByText('Acme for a viewer');
    expect(screen.queryByRole('button', { name: t('messages.new') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('common.send') })).toBeNull();
    expect(screen.getByText(t('messages.composer.readOnly'))).toBeTruthy();
  });
});

describe('the narrowing', () => {
  it('gives a developer only their own messages and no way to the whole stream', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['kata'], null, 'Acme for Kata');
    p.backend.sendTeamMessage('qa', ['fe-1'], null, 'Acme between others');
    p.render(<Pages />, '/p/AC/messages/with/fe-1', asDeveloper(p));
    await within(await screen.findByRole('log')).findByText('Acme for Kata');
    expect(screen.queryByText('Acme between others')).toBeNull();
    expect(screen.queryByRole('button', { name: t('messages.views.all') })).toBeNull();
  });

  it('turns a developer away from the whole stream to the conversations', async () => {
    const p = mockProject();
    p.render(<Pages />, '/p/AC/messages/all?member=fe-1', asDeveloper(p));
    await waitFor(() => expect(where()).toBe('/p/AC/messages'));
    expect(p.requests.some((r) => r.path.includes('member='))).toBe(false);
  });
});

describe('all messages', () => {
  it('lets the owner switch to it and shows who wrote to whom, with the task on every row', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['qa'], 'AC-21', 'Acme between them');
    p.render(<Pages />, '/p/AC/messages');
    fireEvent.click(await screen.findByRole('button', { name: t('messages.views.all') }));
    await waitFor(() => expect(where()).toBe('/p/AC/messages/all'));
    const feed = await screen.findByRole('feed', { name: t('messages.all.feed') });
    expect(await within(feed).findByText(/Frontend fejlesztő → QA/)).toBeTruthy();
    expect(within(feed).getByRole('link', { name: /AC-21/ })).toBeTruthy();
  });

  it('keeps the filters in the address and narrows the rows with them', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['qa'], 'AC-21', 'Acme about twenty-one');
    p.backend.sendTeamMessage('kata', ['qa'], 'AC-22', 'Acme about twenty-two');
    p.render(<Pages />, '/p/AC/messages/all');
    const feed = await screen.findByRole('feed', { name: t('messages.all.feed') });
    await within(feed).findByText('Acme about twenty-one');
    fireEvent.change(screen.getByLabelText(t('messages.all.task')), { target: { value: 'AC-22' } });
    await waitFor(() => expect(where()).toBe('/p/AC/messages/all?task=AC-22'));
    await waitFor(() => expect(within(feed).queryByText('Acme about twenty-one')).toBeNull());
    expect(within(feed).getByText('Acme about twenty-two')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('messages.all.member')), { target: { value: 'kata' } });
    await waitFor(() => expect(where()).toBe('/p/AC/messages/all?member=kata&task=AC-22'));
    fireEvent.click(screen.getByRole('button', { name: t('messages.all.clear') }));
    await waitFor(() => expect(where()).toBe('/p/AC/messages/all'));
    expect(await within(feed).findByText('Acme about twenty-one')).toBeTruthy();
  });

  it('starts from the filters of the address', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['qa'], 'AC-21', 'Acme about twenty-one');
    p.backend.sendTeamMessage('kata', ['qa'], 'AC-22', 'Acme about twenty-two');
    p.render(<Pages />, '/p/AC/messages/all?member=kata');
    const feed = await screen.findByRole('feed', { name: t('messages.all.feed') });
    expect(await within(feed).findByText('Acme about twenty-two')).toBeTruthy();
    expect(within(feed).queryByText('Acme about twenty-one')).toBeNull();
    expect((screen.getByLabelText(t('messages.all.member')) as HTMLSelectElement).value).toBe('kata');
  });

  it('expands a row to read it whole, marks it read and shows the delivery per recipient', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['owner', 'qa'], null, 'Acme long text');
    p.render(<Pages />, '/p/AC/messages/all');
    const feed = await screen.findByRole('feed', { name: t('messages.all.feed') });
    const head = await within(feed).findByRole('button', { expanded: false });
    expect(within(feed).getByRole('img', { name: t('messages.unread') })).toBeTruthy();
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(within(feed).getByText(/QA: /)).toBeTruthy();
    await waitFor(() => expect(readRequests(p)).toHaveLength(1));
    expect(
      within(feed)
        .getByRole('link', { name: t('messages.all.openConversation') })
        .getAttribute('href'),
    ).toBe('/p/AC/messages/with/fe-1');
  });

  it('shows the only-unread filter with the count and keeps it in the address', async () => {
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['owner'], null, 'Acme unread row');
    p.backend.sendTeamMessage('qa', ['kata'], null, 'Acme read row');
    p.render(<Pages />, '/p/AC/messages/all');
    fireEvent.click(await screen.findByRole('button', { name: t('messages.all.unread', { count: 1 }) }));
    await waitFor(() => expect(where()).toBe('/p/AC/messages/all?unread=1'));
    const feed = screen.getByRole('feed', { name: t('messages.all.feed') });
    await waitFor(() => expect(within(feed).queryByText('Acme read row')).toBeNull());
    expect(within(feed).getByText('Acme unread row')).toBeTruthy();
  });
});

describe('on a phone', () => {
  it('shows the list first, then the conversation with a way back', async () => {
    phone(true);
    const p = mockProject();
    p.backend.messages = [];
    p.backend.sendTeamMessage('fe-1', ['owner'], null, 'Acme on the phone');
    p.render(<Pages />, '/p/AC/messages');
    const nav = await screen.findByRole('navigation', { name: t('messages.list.label') });
    expect(screen.queryByRole('region', { name: /Beszélgetés:/ })).toBeNull();
    fireEvent.click(await within(nav).findByRole('link', { name: /olvasatlan/ }));
    await waitFor(() => expect(where()).toBe('/p/AC/messages/with/fe-1'));
    expect(await screen.findByText('Acme on the phone')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: t('messages.list.label') })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: t('messages.thread.back') }));
    await waitFor(() => expect(where()).toBe('/p/AC/messages'));
    expect(await screen.findByRole('navigation', { name: t('messages.list.label') })).toBeTruthy();
  });
});

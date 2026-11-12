import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { isCardMessage, Task } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { openStory } from '../../test/cardStory';
import { showOnScreen } from '../../test/intersection';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

const card = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey/*" element={<TaskDrawer />} />
  </Routes>
);

/** The project as a developer sees it: Kata, who gets messages about the card only when addressed. */
function asDeveloper() {
  const project = mockProject();
  project.backend.viewerHandle = 'kata';
  project.backend.findMember('kata')!.role = 'developer';
  const overrides = {
    myHandle: 'kata',
    isOwner: false,
    me: {
      ...project.context.me,
      handles: { AC: 'kata' },
      projects: [
        { key: 'AC', name: project.context.me.projects[0]!.name, access: 'developer' as const, roles: [] },
      ],
    },
  };
  return { project, overrides };
}

const switchButton = (name: string | RegExp) =>
  within(screen.getByRole('group', { name: t('task.view.label') })).getByRole('button', { name });

/** The messages of the card the owner may see in the block. */
const cardMessages = (project: ReturnType<typeof mockProject>, taskKey: string) =>
  project.backend.messages.filter((message) => message.taskKey === taskKey && isCardMessage(message));

const toggle = (count: number) => screen.findByRole('button', { name: t('task.earlier.title', { count }) });
const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);

describe('the earlier conversations of the Process view (PM-1290)', () => {
  it('shows a closed, read-only block holding the messages written about the card', async () => {
    const project = mockProject();
    const count = cardMessages(project, 'AC-21').length;
    expect(count).toBeGreaterThan(0);
    project.render(card, '/p/AC/tasks/AC-21/steps');
    const button = await toggle(count);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(row('msg_04')?.closest('[hidden]')).not.toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(row('msg_04')?.closest('[hidden]')).toBeNull();
    const section = button.closest('section')!;
    expect(within(section).getByText(t('task.earlier.readOnly'))).toBeTruthy();
    // Nothing is written here: a new message is a comment.
    expect(within(section).queryByRole('textbox')).toBeNull();
    expect(within(section).queryByRole('button', { name: t('messages.reply') })).toBeNull();
  });

  it('reads an unread message only once its mark has been on the screen of the open block (PM-1386)', async () => {
    const project = mockProject();
    const unread = project.backend.sendTeamMessage('fe-1', ['owner'], 'AC-21', 'Earlier unread');
    // A message to a person is a direct conversation; the block holds what the card thread held before.
    delete project.backend.messages.find((message) => message.id === unread.id)!.conversation;
    const reads = () =>
      project.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages/read'));
    project.render(card, '/p/AC/tasks/AC-21/steps');
    const button = await toggle(cardMessages(project, 'AC-21').length);
    const mark = () =>
      within(screen.getByText('Earlier unread').closest('li')!).getByText(t('messages.thread.unread'));
    expect(mark()).toBeTruthy();
    // Opening the block is no reading.
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(reads()).toHaveLength(0);
    showOnScreen(mark()!);
    await waitFor(() => expect(reads()).toHaveLength(1), { timeout: 3000 });
    expect((reads()[0]!.body as { ids: string[] }).ids).toEqual([unread.id]);
  });

  it('names who got a message under it', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21/steps');
    fireEvent.click(await toggle(cardMessages(project, 'AC-21').length));
    expect(row('msg_04')!.textContent).toContain(t('task.earlier.to', { names: 'Frontend fejlesztő' }));
  });

  it('shows a question and its answer as one row, "Te válaszoltál" for the viewer’s own answer', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21/steps');
    fireEvent.click(await toggle(cardMessages(project, 'AC-21').length));
    const qa = row('msg_qa')!;
    expect(qa.textContent).toContain(t('task.thread.asked', { name: 'Frontend fejlesztő' }));
    expect(qa.textContent).toContain('Mutassa az e-mail az összeget?');
    expect(qa.textContent).toContain(t('task.thread.youAnswered', { answer: 'Igen, az összeget is.' }));
    // The answer is not shown a second time as a message.
    expect(screen.queryByText('Az e-mail a megrendelés összegét is mutassa: igen.')).toBeNull();
  });

  it('names the person who answered when it is not the viewer', async () => {
    const project = mockProject();
    project.backend.messages.find((message) => message.id === 'msg_qa')!.from = 'devops';
    project.render(card, '/p/AC/tasks/AC-21/steps');
    fireEvent.click(await toggle(cardMessages(project, 'AC-21').length));
    expect(row('msg_qa')!.textContent).toContain(
      t('task.thread.answered', { name: 'Devops', answer: 'Igen, az összeget is.' }),
    );
  });

  it('is gone for a card nobody wrote about', async () => {
    const project = mockProject();
    project.backend.messages = project.backend.messages.filter((message) => message.taskKey !== 'AC-20');
    project.render(card, '/p/AC/tasks/AC-20/steps');
    await screen.findByRole('heading', { name: new RegExp(`^${t('task.story.title')}`), level: 3 });
    expect(screen.queryByRole('button', { name: /Korábbi beszélgetések/ })).toBeNull();
    expect(screen.queryByText(t('task.earlier.none'))).toBeNull();
  });

  it('has no block on a theme', async () => {
    const project = mockProject();
    const theme = Task.parse(
      project.backend.handle('POST', '/api/projects/AC/tasks', { title: 'Epic', kind: 'theme' }).body,
    );
    project.render(card, `/p/AC/tasks/${theme.key}/steps`);
    await screen.findByRole('group', { name: t('task.view.label') });
    expect(screen.queryByRole('button', { name: /Korábbi beszélgetések/ })).toBeNull();
  });

  it('says a client has no machine message to see when none is visible to them', async () => {
    const project = mockProject();
    project.backend.viewerHandle = 'kata';
    project.backend.config.team.contacts = ['fe-1'];
    project.render(card, '/p/AC/tasks/AC-20/steps', {
      myHandle: 'kata',
      isOwner: false,
      can: { createTasks: false, manageTeam: false, workInSessions: false, comment: true },
      me: {
        ...project.context.me,
        projects: [{ ...project.context.me.projects[0]!, access: 'client' as const }],
      },
    });
    expect(await screen.findByText(t('task.earlier.none'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Korábbi beszélgetések/ })).toBeNull();
  });

  it('shows a developer only the messages addressed to them', async () => {
    const { project, overrides } = asDeveloper();
    // A message to one person is their direct conversation; only one written about the card belongs here.
    const onCard = project.backend.sendTeamMessage('fe-1', ['kata'], 'AC-21', 'Szia Kata, ez neked szól');
    delete onCard.conversation;
    project.backend.sendTeamMessage('fe-1', ['kata'], 'AC-21', 'Ez egy közvetlen üzenet');
    project.render(card, '/p/AC/tasks/AC-21/steps', overrides);
    fireEvent.click(await screen.findByRole('button', { name: /Korábbi beszélgetések/ }));
    expect(screen.getByText('Szia Kata, ez neked szól')).toBeTruthy();
    expect(screen.queryByText('Ez egy közvetlen üzenet')).toBeNull();
    // The owner's question row is not among them.
    expect(row('msg_qa')).toBeNull();
  });

  it('shows a notice of the system as "Rendszer"', async () => {
    const project = mockProject();
    const message = project.backend.sendTeamMessage('fe-1', ['qa'], 'AC-21', 'Relation notice (AC-21)');
    message.from = 'system';
    project.render(card, '/p/AC/tasks/AC-21/steps');
    fireEvent.click(await toggle(cardMessages(project, 'AC-21').length));
    expect(row(message.id)!.textContent).toContain(t('common.system'));
  });
});

describe('the links into the earlier conversations (PM-1290)', () => {
  const message = (project: ReturnType<typeof mockProject>, from: string, to: string[]) =>
    project.backend.addTimeline('AC-21', from, 'team_message', { messageId: 'msg_tl', from, to });

  it('opens the block, scrolls to and highlights the message of an old ?message= link', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21/steps?message=msg_04');
    const button = await toggle(cardMessages(project, 'AC-21').length);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(row('msg_04')?.hasAttribute('data-flash')).toBe(true));
  });

  it('lets the reader close the block that an old link opened', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21/steps?message=msg_04');
    const button = await toggle(cardMessages(project, 'AC-21').length);
    await waitFor(() => expect(row('msg_04')?.hasAttribute('data-flash')).toBe(true));
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the linked message in the middle while the page settles, until the reader scrolls', async () => {
    const project = mockProject();
    const scrolls: unknown[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation((arg) => {
      scrolls.push(arg);
    });
    project.render(card, '/p/AC/tasks/AC-21/steps?message=msg_04');
    await waitFor(() => expect(row('msg_04')?.hasAttribute('data-flash')).toBe(true));
    // A scroll that is not smooth, so a later change of the layout cannot cut it short, and again on a later frame.
    await waitFor(() => expect(scrolls.length).toBeGreaterThan(1));
    expect(scrolls.at(-1)).toMatchObject({ block: 'center', behavior: 'instant' });
    fireEvent.wheel(document.body);
    const stopped = scrolls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(scrolls).toHaveLength(stopped);
  });

  it('waits for a linked message that appears after the page opened', async () => {
    const project = mockProject();
    const answer = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (input, init) => {
      if (String(input).includes('place=card')) await new Promise((resolve) => setTimeout(resolve, 150));
      return answer(input, init);
    });
    project.render(card, '/p/AC/tasks/AC-21/steps?message=msg_04');
    await waitFor(() => expect(row('msg_04')?.hasAttribute('data-flash')).toBe(true));
  });

  it('leads the older conversation link, /thread?message=, to the Process view', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21/thread?message=msg_04');
    const button = await toggle(cardMessages(project, 'AC-21').length);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(switchButton(new RegExp(`^${t('task.view.steps')}`)).getAttribute('aria-pressed')).toBe('true');
  });

  it('links a timeline message to the full message in the Process view, keeping the size', async () => {
    const project = mockProject();
    message(project, 'fe-1', ['qa']);
    project.render(card, '/p/AC/tasks/AC-21/steps?size=large');
    await openStory(screen, true);
    const links = await screen.findAllByRole('link', { name: t('timeline.fullMessage') });
    const link = links.find((candidate) => candidate.getAttribute('href')?.includes('message=msg_tl'))!;
    expect(link.getAttribute('href')).toBe('/p/AC/tasks/AC-21/steps?message=msg_tl&size=large');
  });

  it('offers no link to a message the viewer may not read', async () => {
    const { project, overrides } = asDeveloper();
    message(project, 'fe-1', ['qa']);
    project.render(card, '/p/AC/tasks/AC-21', overrides);
    await screen.findByRole('group', { name: t('task.view.label') });
    await screen.findByText(t('task.description'));
    expect(screen.queryByRole('link', { name: t('timeline.fullMessage') })).toBeNull();
  });

  it('keeps the size in the link of the loop box', async () => {
    const project = mockProject();
    project.backend.config.team.limits.loopWatch = { enabled: true, count: 3, minutes: 30 };
    const devops = project.backend.config.team.members.find((member) => member.handle === 'devops');
    if (devops?.kind === 'ai') devops.role = 'project_manager';
    for (let i = 0; i < 3; i++) {
      const [from, to] = i % 2 === 0 ? ['fe-1', 'code-review'] : ['code-review', 'fe-1'];
      project.backend.addTimeline('AC-21', from!, 'team_message', { messageId: `m${i}`, from, to: [to] });
    }
    project.render(card, '/p/AC/tasks/AC-21?size=large');
    const box = (await screen.findByRole('heading', { name: t('loop.box.title') })).closest('section')!;
    expect(
      within(box)
        .getByRole('link', { name: t('loop.box.messages') })
        .getAttribute('href'),
    ).toBe('/p/AC/tasks/AC-21/thread?size=large');
  });

  it('links the timeline row of a notice, which has no member as its actor, to the full message', async () => {
    const project = mockProject();
    project.backend.addTimeline('AC-21', null, 'team_message', {
      messageId: 'msg_system',
      from: 'system',
      to: ['qa'],
    });
    project.render(card, '/p/AC/tasks/AC-21/timeline');
    // The notice is system noise, folded away until every event is shown.
    await openStory(screen, true);
    const links = await screen.findAllByRole('link', { name: t('timeline.fullMessage') });
    expect(links.some((link) => link.getAttribute('href')?.includes('message=msg_system'))).toBe(true);
  });
});

describe('the failures of the earlier conversations (PM-1358)', () => {
  const failure = (status: number, code: string) =>
    new Response(JSON.stringify({ error: { code, message: 'x' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  /** The messages of the card fail to load until `heal` is called. */
  function failingLoad(project: ReturnType<typeof mockProject>) {
    const answer = createMockFetch(project.backend, project.requests);
    let failing = true;
    setFetchImplementation(async (input, init) =>
      failing && String(input).includes('place=card') ? failure(500, 'internal_error') : answer(input, init),
    );
    return () => {
      failing = false;
    };
  }
  /** Waits for the error state, lets the load work again and presses Retry. */
  const retry = async (heal: () => void) => {
    const alert = (await screen.findByText(t('task.earlier.loadFailed'))).closest<HTMLElement>(
      '[role="alert"]',
    )!;
    heal();
    fireEvent.click(within(alert).getByRole('button', { name: t('app.retry') }));
  };

  it('shows an error state with a retry instead of dropping the block, and moves the focus to the toggle after it', async () => {
    const project = mockProject();
    const heal = failingLoad(project);
    project.render(card, '/p/AC/tasks/AC-21/steps');
    await retry(heal);
    const button = await toggle(cardMessages(project, 'AC-21').length);
    expect(screen.queryByText(t('task.earlier.loadFailed'))).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('leads to the linked message after a retry fixed a failed load', async () => {
    const project = mockProject();
    const heal = failingLoad(project);
    project.render(card, '/p/AC/tasks/AC-21/steps?message=msg_04');
    await retry(heal);
    await waitFor(() => expect(row('msg_04')?.hasAttribute('data-flash')).toBe(true));
  });

  it('shows a toast when the automatic marking as read fails, with the server message of the code', async () => {
    const project = mockProject();
    const unread = project.backend.messages.find((message) => message.id === 'msg_04')!;
    unread.to = [project.backend.viewerHandle];
    unread.receipts = [
      { handle: project.backend.viewerHandle, kind: 'human', deliveredAt: unread.createdAt, readAt: null },
    ];
    const answer = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (input, init) =>
      String(input).endsWith('/messages/read') ? failure(403, 'not_a_recipient') : answer(input, init),
    );
    project.render(<ToastProvider>{card}</ToastProvider>, '/p/AC/tasks/AC-21/steps?message=msg_04');
    await toggle(cardMessages(project, 'AC-21').length);
    await waitFor(() => expect(row('msg_04')).not.toBeNull());
    showOnScreen(within(row('msg_04')!).getByText(t('messages.thread.unread')));
    expect(await screen.findByText(t('errors.codes.not_a_recipient'), {}, { timeout: 3000 })).toBeTruthy();
  });
});

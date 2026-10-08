import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Link, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

const where = () => screen.getByTestId('where').textContent;

const card = (
  <>
    <Where />
    <Routes>
      <Route path="/p/:key/tasks/:taskKey/*" element={<TaskDrawer />} />
    </Routes>
  </>
);

/** Pretends the screen is wide (the two-column window) and not a phone. */
function wideScreen() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: query.includes('min-width'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

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
const thread = () => screen.findByRole('region', { name: t('task.thread.label') });
const composer = (key: string) => screen.getByLabelText(t('task.thread.composerLabel', { key }));
const recipients = () => screen.getByRole('list', { name: t('task.thread.recipients') });

describe('the card view switch (PM-273)', () => {
  it('counts the messages of the card on the switch, and shows no count for a card without any', async () => {
    const project = mockProject();
    const count = project.backend.messages.filter((message) => message.taskKey === 'AC-21').length;
    expect(count).toBeGreaterThan(0);
    project.render(card, '/p/AC/tasks/AC-21');
    await screen.findByRole('group', { name: t('task.view.label') });
    await waitFor(() =>
      expect(switchButton(new RegExp(`^${t('task.view.thread')}\\s*${count}$`))).toBeTruthy(),
    );
  });

  it('shows no count on the switch for a card without messages', async () => {
    const project = mockProject();
    project.backend.messages = project.backend.messages.filter((message) => message.taskKey !== 'AC-22');
    project.render(card, '/p/AC/tasks/AC-22');
    await screen.findByRole('group', { name: t('task.view.label') });
    await waitFor(() => expect(switchButton(t('task.view.thread'))).toBeTruthy());
  });

  it('switches with replace, keeps the size and drops ?message', async () => {
    mockProject().render(card, '/p/AC/tasks/AC-21?size=large');
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${t('task.view.thread')}`) }));
    await waitFor(() => expect(where()).toBe('/p/AC/tasks/AC-21/thread?size=large'));
    await thread();
    fireEvent.click(switchButton(t('task.view.card')));
    await waitFor(() => expect(where()).toBe('/p/AC/tasks/AC-21?size=large'));
  });

  it('drops ?message when the view switches back to the card', async () => {
    mockProject().render(card, '/p/AC/tasks/AC-21/thread?message=msg_04');
    await thread();
    fireEvent.click(switchButton(t('task.view.card')));
    await waitFor(() => expect(where()).toBe('/p/AC/tasks/AC-21'));
  });

  it('opens the conversation from the address and scrolls to and highlights the linked message', async () => {
    mockProject().render(card, '/p/AC/tasks/AC-21/thread?message=msg_04');
    const panel = await thread();
    await waitFor(() => expect(panel.querySelector('[data-message-id="msg_04"]')).toBeTruthy());
    await waitFor(() =>
      expect(panel.querySelector('[data-message-id="msg_04"]')?.hasAttribute('data-flash')).toBe(true),
    );
    expect(switchButton(new RegExp(`^${t('task.view.thread')}`)).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps what is typed in the message box and in the description editor over view switches', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-20/thread');
    await thread();
    fireEvent.change(composer('AC-20'), { target: { value: 'Draft message' } });
    fireEvent.click(switchButton(t('task.view.card')));
    await waitFor(() => expect(where()).toBe('/p/AC/tasks/AC-20'));
    fireEvent.click(await screen.findByRole('button', { name: t('task.editDescription') }));
    fireEvent.change(screen.getByLabelText(t('task.description')), {
      target: { value: 'Draft description' },
    });
    fireEvent.click(switchButton(new RegExp(`^${t('task.view.thread')}`)));
    await waitFor(() => expect(where()).toBe('/p/AC/tasks/AC-20/thread'));
    expect((composer('AC-20') as HTMLTextAreaElement).value).toBe('Draft message');
    fireEvent.click(switchButton(t('task.view.card')));
    await waitFor(() => expect(where()).toBe('/p/AC/tasks/AC-20'));
    expect((screen.getByLabelText(t('task.description')) as HTMLTextAreaElement).value).toBe(
      'Draft description',
    );
  });

  it('keeps the right column in the two-column window while the Thread view shows', async () => {
    wideScreen();
    mockProject().render(card, '/p/AC/tasks/AC-21/thread?size=large');
    await thread();
    // The session link is in the right column: reachable (not hidden) next to the conversation.
    await screen.findByRole('link', { name: t('task.openSession') });
  });

  it('hides the right column in the Thread view of the one-column windows', async () => {
    mockProject().render(card, '/p/AC/tasks/AC-21/thread');
    await thread();
    const link = await screen.findByRole('link', { name: t('task.openSession'), hidden: true });
    expect(link.closest('[hidden]')).not.toBeNull();
  });
});

describe('the card conversation (PM-273)', () => {
  it('shows a question and its answer as one row, "Te válaszoltál" for the viewer’s own answer', async () => {
    mockProject().render(card, '/p/AC/tasks/AC-21/thread');
    const panel = await thread();
    const row = await within(panel).findByRole('group', { name: t('task.thread.qa') });
    expect(row.textContent).toContain(t('task.thread.asked', { name: 'Frontend fejlesztő' }));
    expect(row.textContent).toContain('Mutassa az e-mail az összeget?');
    expect(row.textContent).toContain(t('task.thread.youAnswered', { answer: 'Igen, az összeget is.' }));
    // The answer is not shown a second time as a bubble.
    expect(within(panel).queryByText('Az e-mail a megrendelés összegét is mutassa: igen.')).toBeNull();
  });

  it('names the person who answered when it is not the viewer', async () => {
    const project = mockProject();
    project.backend.messages.find((message) => message.id === 'msg_qa')!.from = 'devops';
    project.render(card, '/p/AC/tasks/AC-21/thread');
    const row = await within(await thread()).findByRole('group', { name: t('task.thread.qa') });
    expect(row.textContent).toContain(
      t('task.thread.answered', { name: 'Devops', answer: 'Igen, az összeget is.' }),
    );
  });

  it('keeps the body of a question with a title closed until "Teljes kérdés" opens it', async () => {
    mockProject().render(card, '/p/AC/tasks/AC-21/thread');
    const row = await within(await thread()).findByRole('group', { name: t('task.thread.qa') });
    const bodyText = /A sablon ma csak a tételeket listázza/;
    expect(within(row).queryByText(bodyText)).toBeNull();
    const more = within(row).getByRole('button', { name: t('inbox.question.more') });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(within(row).getByText(bodyText)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: t('inbox.question.less') }));
    expect(within(row).queryByText(bodyText)).toBeNull();
  });

  it('shows the question waiting for the viewer as an inbox card', async () => {
    const project = mockProject();
    const item = structuredClone(project.backend.inbox.find((candidate) => candidate.id === 'inb_q_ga4')!);
    item.id = 'inb_q_thread';
    item.taskKey = 'AC-21';
    item.title = 'Kell az e-mailben a szállítási díj is?';
    item.payload = { question: item.title, options: ['Igen', 'Nem'] };
    project.backend.inbox.push(item);
    project.render(card, '/p/AC/tasks/AC-21/thread');
    const panel = await thread();
    const section = await within(panel).findByRole('region', { name: t('messages.question.heading') });
    expect(within(section).getByRole('heading', { name: item.title })).toBeTruthy();
  });

  it('shows the empty state of a card nobody wrote about', async () => {
    const project = mockProject();
    project.backend.messages = project.backend.messages.filter((message) => message.taskKey !== 'AC-20');
    project.backend.inbox = project.backend.inbox.filter((item) => item.taskKey !== 'AC-20');
    project.render(card, '/p/AC/tasks/AC-20/thread');
    await within(await thread()).findByRole('heading', { name: t('task.thread.emptyTitle') });
  });

  it('says what the limited view of a developer is, with its own empty state', async () => {
    const { project, overrides } = asDeveloper();
    project.render(card, '/p/AC/tasks/AC-21/thread', overrides);
    const panel = await thread();
    const limited = await within(panel).findByText(t('task.thread.limited'));
    // The line is pinned above the messages, not part of the log that opens at its end.
    expect(within(panel).getByRole('log').contains(limited)).toBe(false);
    // Only what was sent to Kata or by Kata shows: the owner's question row is not among it.
    expect(within(panel).queryByRole('group', { name: t('task.thread.qa') })).toBeNull();
    await within(panel).findByRole('heading', { name: t('task.thread.emptyLimitedTitle') });
    expect(within(panel).getByText(t('task.thread.emptyLimitedBody'))).toBeTruthy();
  });

  it('shows a developer the messages addressed to them', async () => {
    const { project, overrides } = asDeveloper();
    project.backend.sendTeamMessage('fe-1', ['kata'], 'AC-21', 'Szia Kata, ez neked szól');
    project.render(card, '/p/AC/tasks/AC-21/thread', overrides);
    const panel = await thread();
    await within(panel).findByText('Szia Kata, ez neked szól');
    expect(within(panel).queryByText(t('task.thread.emptyLimitedTitle'))).toBeNull();
  });

  it('gives a viewer no box to write in', async () => {
    const { project, overrides } = asDeveloper();
    overrides.me.projects[0]!.access = 'viewer' as never;
    project.backend.findMember('kata')!.role = 'viewer';
    project.render(card, '/p/AC/tasks/AC-21/thread', overrides);
    const panel = await thread();
    await within(panel).findByText(t('messages.composer.readOnly'));
    expect(screen.queryByLabelText(t('task.thread.composerLabel', { key: 'AC-21' }))).toBeNull();
    await within(panel).findByText(t('task.thread.emptyViewerBody'));
  });
});

describe('the recipients of the card conversation (PM-273)', () => {
  const chips = () =>
    within(recipients())
      .queryAllByRole('listitem')
      .map((item) => item.textContent);

  it('defaults to the members working on the card', async () => {
    mockProject().render(card, '/p/AC/tasks/AC-21/thread');
    await thread();
    expect(chips()).toEqual([expect.stringContaining('Frontend fejlesztő')]);
    expect(screen.getByText(t('task.thread.default.workers'))).toBeTruthy();
  });

  it('defaults to the assignee when nobody works on the card', async () => {
    const project = mockProject();
    project.backend.sessions = [];
    project.render(card, '/p/AC/tasks/AC-21/thread');
    await thread();
    expect(chips()).toEqual([expect.stringContaining('Frontend fejlesztő')]);
    expect(screen.getByText(t('task.thread.default.assignee'))).toBeTruthy();
  });

  it('defaults to the owners of the stage when the card has no assignee and no worker', async () => {
    const project = mockProject();
    project.backend.sessions = [];
    project.backend.findTask('AC-25')!.assignee = null;
    project.render(card, '/p/AC/tasks/AC-25/thread');
    await thread();
    expect(chips()).toEqual([expect.stringContaining('Code review')]);
    expect(screen.getByText(t('task.thread.default.stageOwners'))).toBeTruthy();
  });

  it('asks who to write to when there is nobody, and does not send', async () => {
    const project = mockProject();
    project.backend.sessions = [];
    project.backend.findTask('AC-24')!.assignee = null;
    project.render(card, '/p/AC/tasks/AC-24/thread');
    await thread();
    expect(chips()).toEqual([]);
    expect(screen.getByText(t('task.thread.default.none'))).toBeTruthy();
    fireEvent.change(composer('AC-24'), { target: { value: 'Anyone?' } });
    expect((screen.getByRole('button', { name: t('common.send') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets the writer change the recipients, and go back to the default', async () => {
    mockProject().render(card, '/p/AC/tasks/AC-21/thread');
    await thread();
    fireEvent.click(
      screen.getByRole('button', { name: t('task.thread.remove', { name: 'Frontend fejlesztő' }) }),
    );
    expect(chips()).toEqual([]);
    expect(screen.getByText(t('task.thread.edited'), { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: t('task.thread.addTo') }));
    const picker = screen.getByRole('group', { name: t('task.thread.addTo') });
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Devops/ }));
    expect(chips()).toEqual([expect.stringContaining('Devops')]);
    // A client is not offered: a client does not get the team's messages.
    expect(within(picker).queryByRole('checkbox', { name: /Kata/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: t('task.thread.reset') }));
    expect(chips()).toEqual([expect.stringContaining('Frontend fejlesztő')]);
    expect(screen.getByText(t('task.thread.default.workers'))).toBeTruthy();
  });

  it('sends the message with the card key to the chosen recipients', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21/thread');
    await thread();
    fireEvent.change(composer('AC-21'), { target: { value: 'Ping from the card' } });
    fireEvent.click(screen.getByRole('button', { name: t('common.send') }));
    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: '/api/projects/AC/messages',
        body: { to: ['fe-1'], text: 'Ping from the card', taskKey: 'AC-21' },
      }),
    );
    await within(await thread()).findByText('Ping from the card');
  });

  it('starts over on the next card: default recipients, an empty draft, and the send goes to that card', async () => {
    const project = mockProject();
    project.render(
      <>
        {card}
        <Link to="/p/AC/tasks/AC-25/thread">next card</Link>
      </>,
      '/p/AC/tasks/AC-21/thread',
    );
    await thread();
    fireEvent.click(
      screen.getByRole('button', { name: t('task.thread.remove', { name: 'Frontend fejlesztő' }) }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('task.thread.addTo') }));
    fireEvent.click(
      within(screen.getByRole('group', { name: t('task.thread.addTo') })).getByRole('checkbox', {
        name: /Devops/,
      }),
    );
    fireEvent.change(composer('AC-21'), { target: { value: 'Meant for AC-21' } });
    expect(chips()).toEqual([expect.stringContaining('Devops')]);

    fireEvent.click(screen.getByText('next card'));
    await waitFor(() => expect(where()).toBe('/p/AC/tasks/AC-25/thread'));
    await waitFor(() => expect((composer('AC-25') as HTMLTextAreaElement).value).toBe(''));
    expect(screen.queryByText(t('task.thread.edited'), { exact: false })).toBeNull();

    fireEvent.change(composer('AC-25'), { target: { value: 'Meant for AC-25' } });
    fireEvent.click(screen.getByRole('button', { name: t('common.send') }));
    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: '/api/projects/AC/messages',
        body: { to: expect.not.arrayContaining(['devops']), text: 'Meant for AC-25', taskKey: 'AC-25' },
      }),
    );
    expect(
      project.requests.some((request) => JSON.stringify(request.body ?? '').includes('Meant for AC-21')),
    ).toBe(false);
  });
});

describe('the links into the card conversation (PM-273)', () => {
  const message = (project: ReturnType<typeof mockProject>, from: string, to: string[]) =>
    project.backend.addTimeline('AC-21', from, 'team_message', { messageId: 'msg_tl', from, to });

  it('links a timeline message to the full message, keeping the size', async () => {
    const project = mockProject();
    message(project, 'fe-1', ['qa']);
    project.render(card, '/p/AC/tasks/AC-21?size=large');
    const links = await screen.findAllByRole('link', { name: t('timeline.fullMessage') });
    const link = links.find((candidate) => candidate.getAttribute('href')?.includes('message=msg_tl'))!;
    expect(link.getAttribute('href')).toBe('/p/AC/tasks/AC-21/thread?message=msg_tl&size=large');
    fireEvent.click(link);
    await waitFor(() => expect(where()).toBe('/p/AC/tasks/AC-21/thread?message=msg_tl&size=large'));
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
});

describe('the notices of the system in the card conversation (PM-421)', () => {
  const NOTICE = 'Relation notice (AC-21): this card is related to AC-22 (added by qa).';

  /** A message from the system to the given members, the first one typed in at the message's time. */
  function systemNotice(project: ReturnType<typeof mockProject>, to: string[]) {
    const message = project.backend.sendTeamMessage('fe-1', to, 'AC-21', NOTICE);
    message.from = 'system';
    message.receipts = message.to.map((handle, index) => ({
      handle,
      kind: project.backend.findMember(handle)?.kind ?? 'human',
      deliveredAt: index === 0 ? message.createdAt : null,
      readAt: null,
    }));
    return message;
  }

  it('shows the owner who got the notice and when it was typed in, as "Rendszer", without a reply', async () => {
    const project = mockProject();
    const message = systemNotice(project, ['qa', 'devops']);
    project.render(card, '/p/AC/tasks/AC-21/thread');
    const panel = await thread();
    const bubble = (await within(panel).findByText(NOTICE)).closest('[data-message-id]') as HTMLElement;
    expect(bubble.textContent).toContain(t('common.system'));
    expect(within(bubble).queryByRole('button', { name: t('messages.reply') })).toBeNull();
    expect(within(bubble).queryByRole('button', { name: t('messages.thread.replyAll') })).toBeNull();

    fireEvent.click(within(bubble).getByRole('button', { name: t('messages.status.queued') }));
    const details = await screen.findByRole('list', { name: t('messages.status.details') });
    expect(
      within(details).getByText(
        new RegExp(`${t('messages.status.aiTyped')} · ${formatTime(message.createdAt)}`),
      ),
    ).toBeTruthy();
    expect(within(details).getByText(new RegExp(t('messages.status.aiQueued')))).toBeTruthy();
  });

  it('shows a developer the notice addressed to them, without the delivery status and without a reply', async () => {
    const { project, overrides } = asDeveloper();
    systemNotice(project, ['kata']);
    project.render(card, '/p/AC/tasks/AC-21/thread', overrides);
    const panel = await thread();
    const bubble = (await within(panel).findByText(NOTICE)).closest('[data-message-id]') as HTMLElement;
    expect(bubble.textContent).toContain(t('common.system'));
    expect(within(bubble).queryByRole('button', { name: t('messages.status.delivered') })).toBeNull();
    expect(within(bubble).queryByRole('button', { name: t('messages.reply') })).toBeNull();
  });

  it('links the timeline row of a notice, which has no member as its actor, to the full message', async () => {
    const project = mockProject();
    project.backend.addTimeline('AC-21', null, 'team_message', {
      messageId: 'msg_system',
      from: 'system',
      to: ['qa'],
    });
    project.render(card, '/p/AC/tasks/AC-21');
    const links = await screen.findAllByRole('link', { name: t('timeline.fullMessage') });
    expect(links.some((link) => link.getAttribute('href')?.includes('message=msg_system'))).toBe(true);
  });
});

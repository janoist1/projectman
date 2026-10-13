import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import type { CapacityHolder, Session, Task } from '@projectman/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import { startWaitingHint, startWaitingText } from '../../lib/taskState';
import { mockProject } from '../../test/mockProject';
import { mockIndexes } from '../../test/render';
import { MemberProfilePage } from '../team/MemberProfilePage';
import { BoardPage } from './BoardPage';
import { TaskDrawer } from './TaskDrawer';
import { TeamStrip } from './TeamStrip';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const members = mockIndexes().members;
const member = nameOf('be-1', members, 'owner');
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function holder(kind: CapacityHolder['kind'], patch: Partial<CapacityHolder> = {}): CapacityHolder {
  return {
    kind,
    working: false,
    startedAt: minutesAgo(40),
    lastActivityAt: minutesAgo(6.5),
    ...(kind === 'task' ? {} : { sessionId: `ses_${kind}` }),
    ...patch,
  };
}

/** AC-20 waits for `be-1`'s places, which `holders` hold (none: an older server). */
function world(holders?: CapacityHolder[], max = holders?.length ?? 1) {
  const project = mockProject();
  const task = project.backend.findTask('AC-20')!;
  task.startWaiting = {
    reason: 'member_at_capacity',
    member: 'be-1',
    since: task.updatedAt,
    ...(holders ? { holders, capacity: max, closeAfterMinutes: 15 } : {}),
  };
  return { project, task };
}

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);
const box = () => screen.findByRole('region', { name: t('task.whyBox.title') });
const list = (region: HTMLElement) =>
  within(region).getByRole('list', { name: t('task.whyBox.capacityList', { name: member }) });
const lastEntry = (minutes: number) =>
  t('task.whyBox.capacityLastEntry', { ago: t('time.minutesAgo', { count: minutes }) });

describe('the box says what holds the places of the member (PM-297)', () => {
  it('lists one chat, with a link to its session and the tip with a time', async () => {
    const { project } = world([holder('general')]);
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    expect(within(region).getByText(t('task.whyBox.capacityOne'))).toBeTruthy();
    const link = within(list(region)).getByRole('link');
    expect(link.getAttribute('href')).toBe('/p/AC/sessions/ses_general');
    expect(link.getAttribute('aria-label')).toBe(
      t('task.whyBox.capacityLink', { what: t('task.whyBox.capacityRow.general'), meta: lastEntry(6) }),
    );
    const todo = within(region).getByText(/^Semmit\. /).textContent!;
    expect(todo).toContain(t('taskStatus.startHints.capacity.general', { n: 15 }));
    expect(todo).toMatch(/körül indul\.$/);
    // The old sentence is replaced, not repeated.
    expect(within(region).queryByText(t('taskStatus.next.long.capacity'))).toBeNull();
    expect(within(region).queryByText(t('taskStatus.next.todo.auto'))).toBeNull();
  });

  it('says a chat in the middle of a turn is working, and gives no time', async () => {
    const { project } = world([holder('general', { working: true })]);
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    expect(within(list(region)).getByText(t('task.whyBox.capacityWorking'))).toBeTruthy();
    expect(within(region).getByText(/^Semmit\. /).textContent).toBe(
      t('taskStatus.next.todo.capacity', { hint: t('taskStatus.startHints.capacity.general', { n: 15 }) }),
    );
  });

  it('lists a schedule run with a link to its session', async () => {
    const { project } = world([holder('schedule')]);
    project.render(drawer, '/p/AC/tasks/AC-20');
    const item = within(list(await box())).getByRole('link');
    expect(item.getAttribute('href')).toBe('/p/AC/sessions/ses_schedule');
    expect(item.textContent).toContain(t('task.whyBox.capacityRow.schedule'));
  });

  it('lists a meeting with how long it has gone on, and holds the place to its end', async () => {
    const { project } = world([holder('meeting', { working: true, startedAt: minutesAgo(20.5) })]);
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    expect(
      within(list(region)).getByText(
        t('task.whyBox.capacityMeeting', { ago: t('time.minutesAgo', { count: 20 }) }),
      ),
    ).toBeTruthy();
    expect(within(region).getByText(/^Semmit\. /).textContent).toBe(
      t('taskStatus.next.todo.capacity', { hint: t('taskStatus.startHints.capacity.meeting') }),
    );
  });

  it('lists a card with its title as a link, and says "soon" when the time has passed', async () => {
    const { project } = world([holder('task', { taskKey: 'AC-21', lastActivityAt: minutesAgo(40) })]);
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    const title = project.backend.findTask('AC-21')!.title;
    const link = within(list(region)).getByRole('link');
    expect(link.getAttribute('href')).toBe('/p/AC/tasks/AC-21');
    expect(link.textContent).toContain('AC-21');
    expect(link.textContent).toContain(title);
    expect(within(region).getByText(/^Semmit\. /).textContent).toContain(
      t('taskStatus.startHints.capacitySoon'),
    );
  });

  it('lists every holder when there are several, with today’s tip for them', async () => {
    const { project } = world(
      [
        holder('task', { taskKey: 'AC-21', working: true }),
        holder('general', { lastActivityAt: minutesAgo(9.5) }),
        holder('task', { taskKey: undefined, lastActivityAt: minutesAgo(3.5) }),
      ],
      3,
    );
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    expect(within(region).getByText(t('task.whyBox.capacityMany', { max: 3 }))).toBeTruthy();
    const items = within(list(region)).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // A card the viewer cannot see is plain text.
    expect(items[2]!.textContent).toContain(t('task.whyBox.capacityRow.taskHidden'));
    expect(within(items[2]!).queryByRole('link')).toBeNull();
    expect(within(region).getByText(/^Semmit\. /).textContent).toContain(
      t('taskStatus.startHints.capacity.several', { name: member, n: 15 }),
    );
  });

  it('gives a client no link to a session', async () => {
    const { project } = world([holder('general', { sessionId: undefined })]);
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    expect(within(list(region)).queryByRole('link')).toBeNull();
    expect(within(list(region)).getByText(t('task.whyBox.capacityRow.general'))).toBeTruthy();
  });

  it('keeps today’s box without holders', async () => {
    const { project } = world(undefined);
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    expect(
      within(region).queryByRole('list', { name: t('task.whyBox.capacityList', { name: member }) }),
    ).toBeNull();
    expect(within(region).getByText(t('taskStatus.next.long.capacity'))).toBeTruthy();
    expect(within(region).getByText(t('taskStatus.next.todo.auto'))).toBeTruthy();
  });
});

describe('the card row and the sentences say what holds the places (PM-297)', () => {
  const rowTitle = (waiting: string, todoStart: string) =>
    `Ki: ${member} · Mire vár: ${waiting} · Teendő: ${todoStart}`;

  it('names a chat on the board card', async () => {
    const { project } = world([holder('general')]);
    project.render(<BoardPage />);
    await waitFor(() =>
      expect(
        document.querySelector(
          `[title^="${rowTitle(t('taskStatus.next.capacityKinds.general'), 'Semmit. ')}"]`,
        ),
      ).toBeTruthy(),
    );
  });

  it('keeps today’s words for two chats, and without data', async () => {
    const two = world([holder('general'), holder('general', { sessionId: 'ses_2' })], 2);
    two.project.render(<BoardPage />);
    await waitFor(() =>
      expect(
        document.querySelector(
          `[title^="${rowTitle(t('taskStatus.next.startReasons.member_at_capacity'), 'Semmit. ')}"]`,
        ),
      ).toBeTruthy(),
    );
  });

  it('keeps today’s words on the board card without data', async () => {
    const { project } = world(undefined);
    project.render(<BoardPage />);
    await waitFor(() =>
      expect(
        document.querySelector(
          `[title="${rowTitle(t('taskStatus.next.startReasons.member_at_capacity'), t('taskStatus.next.todo.auto'))}"]`,
        ),
      ).toBeTruthy(),
    );
  });

  const waiting = (holders?: CapacityHolder[]): NonNullable<Task['startWaiting']> => ({
    reason: 'member_at_capacity',
    member: 'be-1',
    since: minutesAgo(1),
    ...(holders ? { holders, capacity: 1, closeAfterMinutes: 15 } : {}),
  });
  const ctx = { members, myHandle: 'owner' };

  it('says it in the start sentence, for the project manager’s panel too', () => {
    const say = (holders?: CapacityHolder[]) => startWaitingText(waiting(holders), ctx);
    expect(say([holder('general')])).toBe(`Indulásra vár: ${member} még beszélget`);
    expect(say([holder('schedule')])).toBe(`Indulásra vár: ${member} ütemezett futása tart`);
    expect(say([holder('meeting')])).toBe(`Indulásra vár: ${member} megbeszélésen van`);
    expect(say([holder('task', { taskKey: 'AC-21' })])).toBe(`Indulásra vár: ${member} még dolgozik (AC-21)`);
    expect(say([holder('task', { taskKey: undefined })])).toBe(
      `Indulásra vár: ${member} még dolgozik egy másik kártyán`,
    );
    expect(say([holder('general'), holder('general')])).toBe(`Indulásra vár: ${member} tele van`);
    expect(say(undefined)).toBe(`Indulásra vár: ${member} tele van`);
  });

  it('keeps the old tip without holders', () => {
    const task = { startWaiting: waiting(undefined) } as Task;
    expect(startWaitingHint(task, members, 'owner')).toBe(t('taskStatus.startHints.member_at_capacity'));
  });
});

describe('the board strip shows who a card waits for (PM-297)', () => {
  const titles = new Map([
    ['AC-20', 'Napi mentés'],
    ['AC-21', 'E-mail'],
  ]);

  function strip(holders: CapacityHolder[] | undefined, waitingCards = ['AC-20']) {
    const { project } = world(holders);
    const tasks = waitingCards.map((key) => {
      const task = project.backend.findTask(key)!;
      task.startWaiting = { ...project.backend.findTask('AC-20')!.startWaiting! };
      return task;
    });
    const team = project.backend.members.map((entry) => ({ ...entry, taskWork: [] }));
    project.render(<TeamStrip members={team} titles={titles} tasks={tasks} />);
    return screen.queryAllByRole('listitem').map((item) => within(item).getByRole('link'));
  }

  it('shows a member who works on no card, with the kind and the mark', () => {
    const [chip] = strip([holder('general')]);
    expect(chip!.getAttribute('href')).toBe('/p/AC/team/be-1');
    expect(chip!.textContent).toContain(t('taskStatus.capacityNames.general'));
    expect(chip!.textContent).toContain(t('board.waitedFor', { key: 'AC-20' }));
    expect(chip!.getAttribute('aria-label')).toBe(
      t('board.waitedForChip', {
        name: member,
        holders: t('taskStatus.capacityNames.general'),
        waiting: t('board.waitedFor', { key: 'AC-20' }),
      }),
    );
  });

  it('leads to the card when it is the one place holder the viewer sees', () => {
    const [chip] = strip([holder('task', { taskKey: 'AC-21' })]);
    expect(chip!.getAttribute('href')).toBe('/p/AC/tasks/AC-21');
    expect(chip!.textContent).toContain('AC-21');
    expect(chip!.textContent).toContain('E-mail');
  });

  it('puts the card and the kind together, and counts the cards that wait', () => {
    const [chip] = strip([holder('task', { taskKey: 'AC-21' }), holder('general')], ['AC-20', 'AC-22']);
    expect(chip!.getAttribute('href')).toBe('/p/AC/team/be-1');
    expect(chip!.textContent).toContain('AC-21');
    expect(chip!.textContent).toContain(t('taskStatus.capacityNames.general'));
    expect(chip!.textContent).toContain(t('board.waitedForMany', { count: 2 }));
  });

  it('names a card the viewer cannot see "another card"', () => {
    const [chip] = strip([holder('task', { taskKey: undefined })]);
    expect(chip!.textContent).toContain(t('taskStatus.capacityNames.taskHidden'));
    expect(chip!.getAttribute('href')).toBe('/p/AC/team/be-1');
  });

  it('adds nobody without holders', () => {
    expect(strip(undefined)).toHaveLength(0);
  });
});

describe('the member profile says the member is full (PM-297)', () => {
  const page = (
    <Routes>
      <Route path="/team/:handle" element={<MemberProfilePage />} />
    </Routes>
  );

  const fullNote = async () =>
    (await screen.findByText(t('profile.full'))).closest('[role="status"]') as HTMLElement;

  /** `be-1` holds its place with an idle chat, not with the card it worked on. */
  function chatting(project: ReturnType<typeof mockProject>, extra: Partial<Session> = {}) {
    const chat = project.backend.sessions.find((s) => s.member === 'be-1')!;
    project.backend.sessions = [
      ...project.backend.sessions.filter((s) => s.member !== 'be-1'),
      {
        ...chat,
        id: 'ses_chat',
        workItem: { type: 'general' },
        state: 'idle',
        lastActivityAt: minutesAgo(6.5),
        ...extra,
      },
    ];
  }

  it('names the waiting cards, what holds the place and the tip', async () => {
    const { project } = world([holder('general')]);
    chatting(project);
    project.render(page, '/team/be-1');
    const note = await fullNote();
    expect(note.textContent).toContain(`${t('profile.full')} ${t('profile.fullWaiting')} AC-20`);
    expect(within(note).getByRole('link', { name: 'AC-20' }).getAttribute('href')).toBe('/p/AC/tasks/AC-20');
    expect(
      within(note)
        .getByRole('link', { name: t('taskStatus.capacityNames.general') })
        .getAttribute('href'),
    ).toBe('/p/AC/sessions/ses_chat');
    expect(note.textContent).toContain(t('profile.fullMeta', { meta: lastEntry(6) }));
    expect(note.textContent).toContain(t('taskStatus.startHints.capacity.general', { n: 15 }));
    expect(note.textContent).not.toContain('Semmit');
  });

  it('counts the places when there are several', async () => {
    const { project } = world([holder('general')]);
    const configured = project.backend.config.team.members.find((m) => m.handle === 'be-1')!;
    if (configured.kind === 'ai') configured.capacity = 2;
    chatting(project);
    const second = { ...project.backend.sessions.at(-1)!, id: 'ses_chat2', lastActivityAt: minutesAgo(12.5) };
    project.backend.sessions.push(second);
    project.render(page, '/team/be-1');
    const note = await screen.findByText(t('profile.fullOf', { used: 2, max: 2 }));
    expect(note.closest('[role="status"]')).toBeTruthy();
  });

  it('says nothing while no card waits for the member', async () => {
    const project = mockProject();
    chatting(project);
    project.render(page, '/team/be-1');
    await screen.findByRole('button', { name: t('team.moreFor', { name: member }) });
    expect(screen.queryByText(t('profile.full'))).toBeNull();
    expect(screen.queryByText(t('profile.fullWaiting'), { exact: false })).toBeNull();
  });
});

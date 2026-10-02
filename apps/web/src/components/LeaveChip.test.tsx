import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemberView } from '@projectman/shared';
import { setFetchImplementation } from '../api/client';
import { TaskDrawer } from '../features/board/TaskDrawer';
import { TeamStrip } from '../features/board/TeamStrip';
import { MessageComposer } from '../features/messages/MessageComposer';
import { SessionPage } from '../features/session/SessionPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { t } from '../i18n/t';
import { mockProject } from '../test/mockProject';
import { LeaveChip, leaveSuffix, MemberNames } from './LeaveChip';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const onLeave = t('leave.onLeave');

/** Sends the member on leave the way the Team page does: a PATCH the fake backend applies. */
function sendOnLeave(project: ReturnType<typeof mockProject>, ...handles: string[]) {
  for (const handle of handles)
    project.backend.handle('PATCH', `/api/projects/AC/members/${handle}`, { onLeave: true });
}

const nameOfMember = (project: ReturnType<typeof mockProject>, handle: string) =>
  project.backend.members.find((member) => member.handle === handle)!.displayName;

describe('LeaveChip', () => {
  const ai = { kind: 'ai', onLeave: true } as const;

  it('shows the mark for an AI member on leave, and nothing for anyone else', () => {
    const { container } = render(
      <>
        <LeaveChip member={ai} />
        <LeaveChip member={{ kind: 'ai', onLeave: false }} />
        <LeaveChip member={{ kind: 'ai' }} />
        <LeaveChip member={{ kind: 'human', onLeave: true }} />
        <LeaveChip member={undefined} />
        <LeaveChip member={null} />
      </>,
    );
    expect(screen.getAllByText(onLeave)).toHaveLength(1);
    expect(container.children).toHaveLength(1);
  });

  it('gives the text for an option or a label only for a member on leave', () => {
    expect(leaveSuffix(ai)).toBe(` · ${onLeave}`);
    expect(leaveSuffix({ kind: 'ai' })).toBe('');
    expect(leaveSuffix(undefined)).toBe('');
  });

  it('marks only the member on leave in a list of names, which stay joined the Hungarian way', () => {
    const member = (handle: string, displayName: string, away: boolean): MemberView =>
      ({ handle, displayName, kind: 'ai', ...(away ? { onLeave: true } : {}) }) as MemberView;
    const members = new Map([
      ['a', member('a', 'Alfa', false)],
      ['b', member('b', 'Beta', true)],
      ['c', member('c', 'Gamma', false)],
    ]);
    const { container } = render(<MemberNames handles={['a', 'b', 'c']} members={members} myHandle={null} />);
    expect(container.textContent).toBe(
      `Alfa${t('common.listSeparator')}Beta ${onLeave}${t('common.and')}Gamma`,
    );
    expect(screen.getAllByText(onLeave)).toHaveLength(1);
  });

  it('is the only place in the web that reads the leave text', () => {
    const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    const readers = Object.entries(sources)
      .filter(([, source]) => source.includes('leave.onLeave'))
      .map(([path]) => path);
    expect(readers).toEqual(['./LeaveChip.tsx']);
  });
});

describe('where a member on leave is marked (PM-227)', () => {
  const drawer = (
    <Routes>
      <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
    </Routes>
  );

  it('keeps a member on leave off the board strip, with or without anyone working (PM-259)', () => {
    const project = mockProject();
    sendOnLeave(project, 'fe-1');
    const team = (working: string[]) =>
      project.backend.members.map((member): MemberView => ({
        ...member,
        taskWork: working.includes(member.handle)
          ? [{ sessionId: 's1', taskKey: 'AC-20', activity: null, since: '2026-10-02T10:00:00.000Z' }]
          : [],
      }));
    const titles = new Map([['AC-20', 'Napi mentés']]);
    const view = project.render(<TeamStrip members={team([])} titles={titles} />);
    expect(screen.getByText(t('board.nobodyWorking'))).toBeTruthy();
    expect(screen.queryByText(nameOfMember(project, 'fe-1'))).toBeNull();
    expect(screen.queryByText(onLeave)).toBeNull();
    view.unmount();

    project.render(<TeamStrip members={team(['be-1'])} titles={titles} />);
    const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(links).toEqual(['/p/AC/tasks/AC-20']);
    expect(screen.queryByText(onLeave)).toBeNull();
  });

  it('shows nothing on the strip when nobody is on leave', () => {
    const project = mockProject();
    project.render(<TeamStrip members={project.backend.members} titles={new Map()} />);
    expect(screen.queryByText(onLeave)).toBeNull();
  });

  it('marks the participant on leave in the session panel', async () => {
    const project = mockProject();
    sendOnLeave(project, 'fe-1');
    project.render(
      <Routes>
        <Route path="/sessions/:sessionId" element={<SessionPage />} />
      </Routes>,
      '/sessions/ses_ac21_fe1',
    );
    // Not a wide screen: the panels are the "details" tab.
    fireEvent.click(await screen.findByRole('tab', { name: t('session.tabs.details') }));
    const panel = await screen.findByRole('region', { name: t('session.participants') });
    const person = within(panel).getByText(nameOfMember(project, 'fe-1')).closest('li')!;
    expect(within(person).getByText(onLeave)).toBeTruthy();
    expect(within(panel).getAllByText(onLeave)).toHaveLength(1);
  });

  it('keeps a member on leave out of the picks for who carries a card, and says why', async () => {
    const project = mockProject();
    sendOnLeave(project, 'fe-1');
    project.render(drawer, '/p/AC/tasks/AC-23');
    const select = (await screen.findByLabelText(t('task.assigneeLabel'))) as HTMLSelectElement;
    const option = (handle: string) => Array.from(select.options).find((o) => o.value === handle)!;
    expect(option('fe-1').disabled).toBe(true);
    expect(option('fe-1').textContent).toContain(onLeave);
    expect(option('fe-1').textContent).not.toContain(t('memberStatus.idle'));
    expect(option('be-1').disabled).toBe(false);
    expect(option('be-1').textContent).not.toContain(onLeave);
  });

  it('marks the assignee on leave in the select and in the read-only line', async () => {
    const project = mockProject();
    sendOnLeave(project, 'be-1');
    const view = project.render(drawer, '/p/AC/tasks/AC-20');
    const select = (await screen.findByLabelText(t('taskLifecycle.assignee'))) as HTMLSelectElement;
    expect(select.selectedOptions[0]!.textContent).toContain(onLeave);
    view.unmount();

    project.render(drawer, '/p/AC/tasks/AC-20', {
      can: { createTasks: true, manageTeam: false, workInSessions: false },
    });
    const line = (await screen.findByText(t('taskLifecycle.assignee'))).parentElement!;
    expect(within(line).getByText(onLeave)).toBeTruthy();
  });

  it('marks an owner of the next stage on leave in the "next" row', async () => {
    const project = mockProject();
    sendOnLeave(project, 'code-review');
    project.render(drawer, '/p/AC/tasks/AC-20');
    const row = (await screen.findByText(t('task.next'))).closest('li')!;
    expect(within(row).getByText(onLeave)).toBeTruthy();
    expect(row.textContent).toContain(nameOfMember(project, 'code-review'));
  });

  it('marks a stage owner on leave in settings, and keeps it selectable in the editor', async () => {
    const project = mockProject();
    sendOnLeave(project, 'fe-1');
    project.render(<SettingsPage />);
    const region = within(await screen.findByRole('region', { name: t('settings.sections.pipeline') }));
    const owners = (await region.findByText(nameOfMember(project, 'fe-1'))).closest('span')!;
    expect(within(owners).getByText(onLeave)).toBeTruthy();

    fireEvent.click(region.getByRole('button', { name: t('memberEdit.edit') }));
    const options = await waitFor(() => {
      const found = region.getAllByRole('option', { name: new RegExp(onLeave) }) as HTMLOptionElement[];
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(options.every((option) => option.textContent?.includes(nameOfMember(project, 'fe-1')))).toBe(true);
    expect(options.every((option) => !option.disabled)).toBe(true);
  });

  it('marks a recipient on leave, who can still be chosen', async () => {
    const project = mockProject();
    sendOnLeave(project, 'fe-1');
    project.render(<MessageComposer />);
    const box = await screen.findByRole('checkbox', { name: new RegExp(nameOfMember(project, 'fe-1')) });
    expect(within(box.closest('label')!).getByText(onLeave)).toBeTruthy();
    expect((box as HTMLInputElement).disabled).toBe(false);
  });
});

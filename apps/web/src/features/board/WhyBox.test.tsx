import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import { mockProject } from '../../test/mockProject';
import { mockIndexes } from '../../test/render';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey" element={<TaskDrawer />} />
  </Routes>
);

const box = () => screen.findByRole('region', { name: t('task.whyBox.title') });
const row = (region: HTMLElement, name: string) => {
  const term = within(region).getByText(name, { selector: 'dt' });
  return term.parentElement as HTMLElement;
};

/** AC-20 stands in the work stage; `be-1` finished it and the card mover is asked. */
function handOnProject(mover: string) {
  const project = mockProject();
  project.backend.config.team.cardMover = { kind: 'human', handle: mover };
  project.backend.moveAs('AC-20', 'code_review', 'be-1');
  // The member has finished: no session works on the card any more.
  project.backend.sessions = project.backend.sessions.filter((session) => session.member !== 'be-1');
  return project;
}

describe('"Miért áll?" box in the drawer (PM-461)', () => {
  it('has four rows and the move button for the card mover, and does not repeat it in an inbox card', async () => {
    const project = handOnProject('owner');
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    expect(
      within(region)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual([t('task.whyBox.who'), t('task.whyBox.waiting'), t('task.whyBox.to'), t('task.whyBox.todo')]);
    // Who: the viewer, with the kind of member.
    expect(row(region, t('task.whyBox.who')).textContent).toContain(t('task.whyBox.kindHuman'));
    expect(row(region, t('task.whyBox.to')).textContent).toBe(
      `${t('task.whyBox.to')}${t('task.whyBox.route', { from: 'Fejlesztés', to: 'Code review' })}`,
    );
    const moveName = t('task.whyBox.move', { stage: 'Code review' });
    expect(within(region).getByRole('button', { name: moveName })).toBeTruthy();
    // The inbox card of the same item would be a second button and a second text.
    expect(screen.getAllByRole('button', { name: moveName })).toHaveLength(1);
    expect(screen.queryByText(t('inbox.kinds.hand_on'))).toBeNull();
  });

  it('moves the card on a click, and the box goes away when the card has no wait left to show', async () => {
    const project = handOnProject('owner');
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    fireEvent.click(
      within(region).getByRole('button', { name: t('task.whyBox.move', { stage: 'Code review' }) }),
    );
    await waitFor(() => expect(project.backend.findTask('AC-20')!.stageId).toBe('code_review'));
    expect(project.requests.some((request) => request.path.endsWith('/resolve'))).toBe(true);
    expect(project.backend.findTask('AC-20')!.handOn).toBeUndefined();
    // No toast in the box.
    expect(screen.queryByRole('status', { name: /./ })).toBeNull();
  });

  it('shows the gate error under the button when the move is refused, and the button works again', async () => {
    const project = handOnProject('owner');
    project.backend.config.pipeline.stages.find((stage) => stage.id === 'code_review')!.gate = {
      conditions: [{ type: 'has_label', label: 'design-review-ok' }],
    };
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    const button = within(region).getByRole('button', {
      name: t('task.whyBox.move', { stage: 'Code review' }),
    });
    fireEvent.click(button);
    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toMatch(/^A kapu még nem enged tovább/);
    // The error names what is missing, not only that the gate is shut.
    expect(alert.textContent).toContain(
      t('errors.gateUnmet', {
        conditions: t('settings.pipeline.gateHasLabel', { label: 'design-review-ok' }),
      }),
    );
    expect(project.backend.findTask('AC-20')!.stageId).toBe('dev');
    expect(project.backend.inbox.find((item) => item.kind === 'hand_on')?.state).toBe('open');
    await waitFor(() =>
      expect(
        (
          within(region).getByRole('button', {
            name: t('task.whyBox.move', { stage: 'Code review' }),
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });

  it('shows no button to a viewer who is not next, with the card mover named', async () => {
    const project = handOnProject('kata');
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    expect(within(region).queryByRole('button')).toBeNull();
    expect(row(region, t('task.whyBox.who')).textContent).toContain('Kata');
    expect(row(region, t('task.whyBox.to'))).toBeTruthy();
  });

  it('shows the three rows and no button for a card that waits for a busy member', async () => {
    const project = mockProject();
    const task = project.backend.findTask('AC-20')!;
    task.startWaiting = {
      reason: 'member_at_capacity',
      member: 'be-1',
      since: task.updatedAt,
    };
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    expect(
      within(region)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual([t('task.whyBox.who'), t('task.whyBox.waiting'), t('task.whyBox.todo')]);
    expect(within(region).queryByRole('button')).toBeNull();
    // The busy member is named, with the kind chip.
    const who = row(region, t('task.whyBox.who')).textContent;
    expect(who).toContain(nameOf('be-1', mockIndexes().members, 'owner'));
    expect(who).toContain(t('task.whyBox.kindAi'));
    expect(within(region).getByText(t('taskStatus.next.todo.auto'))).toBeTruthy();
  });

  it('names the Senior role, not "nobody", while a Senior card waits for whoever is free first', async () => {
    const project = mockProject();
    const task = project.backend.findTask('AC-20')!;
    task.startWaiting = { reason: 'senior_busy', since: task.updatedAt };
    project.render(drawer, '/p/AC/tasks/AC-20');
    const region = await box();
    const who = row(region, t('task.whyBox.who')).textContent;
    expect(who).toContain(t('task.whyBox.nobodySenior'));
    expect(who).toContain(t('task.whyBox.kindAi'));
    expect(who).not.toContain(t('task.whyBox.nobodyAuto'));
  });

  it('is not there while somebody works on the card', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-20');
    await screen.findAllByText(project.backend.findTask('AC-20')!.title);
    expect(screen.queryByRole('region', { name: t('task.whyBox.title') })).toBeNull();
  });

  it('keeps the inbox card for other kinds of items: the box has no button for a permission', async () => {
    const project = mockProject();
    project.render(drawer, '/p/AC/tasks/AC-21');
    const region = await box();
    expect(within(region).getByText(t('taskStatus.next.todo.inboxYou'))).toBeTruthy();
    expect(within(region).queryByRole('button')).toBeNull();
    // The permission's own card, with its options, stays where it was.
    expect(screen.getByRole('button', { name: t('inbox.options.allow') })).toBeTruthy();
  });
});

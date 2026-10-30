import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Task } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
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

const storyTitle = new RegExp(`^${t('task.story.title')}`);
const views = () => screen.findByRole('group', { name: t('task.view.label') });
const viewButton = (label: string) =>
  within(screen.getByRole('group', { name: t('task.view.label') })).getByRole('button', {
    name: new RegExp(`^${label}`),
  });
const pressed = () =>
  within(screen.getByRole('group', { name: t('task.view.label') }))
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.querySelector('span')!.textContent);

const attach = (project: ReturnType<typeof mockProject>, ...names: string[]) =>
  names.forEach((name) =>
    project.backend.addAttachment('AC-21', { name, size: 100, type: 'application/pdf' }),
  );

describe('the views of the open card (PM-487)', () => {
  it('has four views in a row, the attachments with their count', async () => {
    const project = mockProject();
    attach(project, 'a.pdf', 'b.pdf');
    project.render(card, '/p/AC/tasks/AC-21');
    const group = await views();
    await waitFor(() => expect(within(group).getAllByRole('button')).toHaveLength(4));
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.querySelector('span')!.textContent),
    ).toEqual([t('task.view.card'), t('task.view.thread'), t('task.view.attachments'), t('task.view.steps')]);
    await waitFor(() => expect(within(viewButton(t('task.view.attachments'))).getByText('2')).toBeTruthy());
  });

  it('shows no count for a card without attachments', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21');
    await views();
    await screen.findByText(t('task.description'));
    expect(viewButton(t('task.view.attachments')).querySelectorAll('span')).toHaveLength(1);
  });

  it('keeps the attachments and the story off the card view, and shows each on its own view', async () => {
    const project = mockProject();
    attach(project, 'a.pdf');
    project.render(card, '/p/AC/tasks/AC-21');
    await views();
    await screen.findByText(t('task.description'));
    expect(pressed()).toEqual([t('task.view.card')]);
    expect(screen.queryByRole('region', { name: t('attachments.title') })).toBeNull();
    expect(screen.queryByRole('heading', { name: storyTitle })).toBeNull();
    expect(screen.queryByLabelText(t('task.comments.label'))).toBeTruthy(); // in the tree, for the draft

    fireEvent.click(viewButton(t('task.view.attachments')));
    expect(where()).toBe('/p/AC/tasks/AC-21/attachments');
    expect(await screen.findByRole('region', { name: t('attachments.title') })).toBeTruthy();
    expect(await screen.findByRole('list', { name: t('attachments.listLabel') })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: storyTitle })).toBeNull();
    expect(screen.queryByRole('heading', { name: t('task.description') })).toBeNull();

    fireEvent.click(viewButton(t('task.view.steps')));
    expect(where()).toBe('/p/AC/tasks/AC-21/steps');
    expect(await screen.findByRole('heading', { name: storyTitle })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: t('task.comments.label') })).toBeTruthy();
    expect(screen.queryByRole('region', { name: t('attachments.title') })).toBeNull();

    fireEvent.click(viewButton(t('task.view.card')));
    expect(where()).toBe('/p/AC/tasks/AC-21');
    expect(await screen.findByText(t('task.description'))).toBeTruthy();
  });

  it('opens the view of the link, and the card for a view it does not know', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21/attachments');
    await views();
    expect(pressed()).toEqual([t('task.view.attachments')]);
    expect(await screen.findByText(t('attachments.none'))).toBeTruthy();
  });

  it('shows the card for a sub-path it does not know', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21/nothing');
    await views();
    expect(pressed()).toEqual([t('task.view.card')]);
  });

  it('keeps the size when the view changes', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21?size=large');
    await views();
    fireEvent.click(viewButton(t('task.view.steps')));
    expect(where()).toBe('/p/AC/tasks/AC-21/steps?size=large');
  });

  it('keeps a comment that was begun when another view is shown', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21/steps');
    const box = (await screen.findByRole('textbox', {
      name: t('task.comments.label'),
    })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Half a comment' } });
    fireEvent.click(viewButton(t('task.view.card')));
    fireEvent.click(viewButton(t('task.view.steps')));
    expect(
      (screen.getByRole('textbox', { name: t('task.comments.label') }) as HTMLTextAreaElement).value,
    ).toBe('Half a comment');
  });

  it('shows the writing of a comment on the process view, not on the card view', async () => {
    const project = mockProject();
    project.render(card, '/p/AC/tasks/AC-21');
    await views();
    await screen.findByText(t('task.description'));
    expect(screen.queryByRole('textbox', { name: t('task.comments.label') })).toBeNull();
  });

  it('opens the process view for the older /timeline sub-path, at the event a link points at', async () => {
    const project = mockProject();
    const note = project.backend.timeline.find(
      (event) => event.taskKey === 'AC-21' && event.type === 'task_note',
    )!;
    const reached: string[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      reached.push(this.id);
    });
    project.render(card, `/p/AC/tasks/AC-21/timeline#timeline-${note.id}`);
    await views();
    expect(pressed()).toEqual([t('task.view.steps')]);
    await waitFor(() => expect(reached).toContain(`timeline-${note.id}`));
  });

  it('opens the process view for an older link to one event, without a sub-path', async () => {
    const project = mockProject();
    const note = project.backend.timeline.find(
      (event) => event.taskKey === 'AC-21' && event.type === 'task_note',
    )!;
    const reached: string[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      reached.push(this.id);
    });
    project.render(card, `/p/AC/tasks/AC-21#timeline-${note.id}`);
    await views();
    expect(pressed()).toEqual([t('task.view.steps')]);
    await waitFor(() => expect(reached).toContain(`timeline-${note.id}`));
  });

  it('gives a theme the same views, without the conversation, and the card for its /thread', async () => {
    const project = mockProject();
    const theme = Task.parse(
      project.backend.handle('POST', '/api/projects/AC/tasks', { title: 'Epic', kind: 'theme' }).body,
    );
    project.render(card, `/p/AC/tasks/${theme.key}/thread`);
    const group = await views();
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.querySelector('span')!.textContent),
    ).toEqual([t('task.view.card'), t('task.view.attachments'), t('task.view.steps')]);
    expect(pressed()).toEqual([t('task.view.card')]);
    fireEvent.click(viewButton(t('task.view.steps')));
    expect(where()).toBe(`/p/AC/tasks/${theme.key}/steps`);
    expect(await screen.findByRole('heading', { name: storyTitle })).toBeTruthy();
    // A theme has no "Most" box.
    expect(screen.queryByRole('region', { name: t('task.steps.now') })).toBeNull();
  });
});

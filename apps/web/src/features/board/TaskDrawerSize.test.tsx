import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { ProjectContext } from '../../app/contexts';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { findBoardCardLinks } from '../../test/boardCards';
import { mockProject } from '../../test/mockProject';
import { renderUi } from '../../test/render';
import { AttachmentUploadsProvider } from './attachmentUploads';
import { BoardPage } from './BoardPage';
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

/** The board and the open card as the app mounts them, with the address on show. */
function renderBoard(route: string, project = mockProject()) {
  const view = renderUi(
    <ToastProvider>
      <ProjectContext.Provider value={project.context}>
        <AttachmentUploadsProvider>
          <Where />
          <Routes>
            <Route path="/p/:key" element={<BoardPage />}>
              <Route path="tasks/:taskKey" element={<TaskDrawer />} />
            </Route>
          </Routes>
        </AttachmentUploadsProvider>
      </ProjectContext.Provider>
    </ToastProvider>,
    { route },
  );
  return { project, ...view };
}

/** Pretends the screen matches these media queries (a phone: max-width; wide: min-width 1104px). */
function screenIs(match: (query: string) => boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: match(query),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

const quickView = () => screen.findByRole('complementary', { name: t('task.drawerLabel') });
const largeView = () => screen.findByRole('dialog', { name: t('task.drawerLabel') });
const toLarge = () => screen.getByRole('button', { name: t('task.size.large') });
const toQuick = () => screen.getByRole('button', { name: t('task.size.quick') });
const ownerTask = 'AC-20';
const parentName = new RegExp(`^${t('task.parent', { key: ownerTask, title: '' })}`);

describe('the card in the quick view and in the large window (PM-283)', () => {
  it('opens in the quick view from the board, and the head switches to the large window and back', async () => {
    const { project } = renderBoard('/p/AC');
    const [link] = await findBoardCardLinks(project.backend.findTask(ownerTask)!.title);
    fireEvent.click(link!);
    const drawer = await quickView();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(where()).toBe(`/p/AC/tasks/${ownerTask}`);
    expect(toLarge().getAttribute('title')).toBe(t('task.size.large'));

    fireEvent.click(toLarge());
    const window = await largeView();
    // The same element changes its role: what is typed in it is not lost.
    expect(window).toBe(drawer);
    expect(window.getAttribute('aria-modal')).toBe('true');
    expect(where()).toBe(`/p/AC/tasks/${ownerTask}?size=large`);
    expect(toQuick().getAttribute('title')).toBe(t('task.size.quick'));

    fireEvent.click(toQuick());
    expect(await quickView()).toBe(drawer);
    expect(where()).toBe(`/p/AC/tasks/${ownerTask}`);
  });

  it('opens large from the address, on refresh and from a link', async () => {
    renderBoard(`/p/AC/tasks/${ownerTask}?size=large`);
    const window = await largeView();
    await within(window).findByRole('button', { name: t('task.size.quick') });
    expect(screen.queryByRole('complementary', { name: t('task.drawerLabel') })).toBeNull();
  });

  it.each([
    [
      'the close button',
      () => fireEvent.click(screen.getAllByRole('button', { name: t('common.close') })[0]!),
    ],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['a click on the backdrop', () => fireEvent.click(document.querySelector('[data-inert-exempt]')!)],
  ])('closes the large window with %s, back to the board', async (_name, close) => {
    renderBoard(`/p/AC/tasks/${ownerTask}?size=large`);
    await largeView();
    close();
    await waitFor(() => expect(where()).toBe('/p/AC'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts all that lies under the large window out of reach, and gives it back', async () => {
    const { container } = renderBoard(`/p/AC/tasks/${ownerTask}?size=large`);
    const window = await largeView();
    await waitFor(() => expect(container.querySelectorAll('[inert]').length).toBeGreaterThan(0));
    expect(window.closest('[inert]')).toBeNull();
    // The backdrop takes the click that closes it: it must not be inert.
    expect(document.querySelector('[data-inert-exempt]')!.closest('[inert]')).toBeNull();
    fireEvent.click(toQuick());
    await quickView();
    expect(container.querySelectorAll('[inert]')).toHaveLength(0);
  });

  it('leaves the board within reach in the quick view', async () => {
    const { container } = renderBoard(`/p/AC/tasks/${ownerTask}`);
    await quickView();
    expect(container.querySelectorAll('[inert]')).toHaveLength(0);
  });

  it('keeps the size in the link to the parent', async () => {
    const project = mockProject();
    project.backend.findTask('AC-21')!.parentKey = ownerTask;
    renderBoard('/p/AC/tasks/AC-21?size=large', project);
    const window = await largeView();
    const parent = await within(window).findByRole('link', { name: parentName });
    expect(parent.getAttribute('href')).toBe(`/p/AC/tasks/${ownerTask}?size=large`);
    fireEvent.click(parent);
    await waitFor(() => expect(where()).toBe(`/p/AC/tasks/${ownerTask}?size=large`));
    await largeView();
  });

  it('does not keep the size in the link to the parent of a card in the quick view', async () => {
    const project = mockProject();
    project.backend.findTask('AC-21')!.parentKey = ownerTask;
    renderBoard('/p/AC/tasks/AC-21', project);
    const drawer = await quickView();
    const parent = await within(drawer).findByRole('link', { name: parentName });
    expect(parent.getAttribute('href')).toBe(`/p/AC/tasks/${ownerTask}`);
  });

  it('keeps an open description edit, with its text, through the switch', async () => {
    renderBoard(`/p/AC/tasks/${ownerTask}`);
    await quickView();
    fireEvent.click(await screen.findByRole('button', { name: t('task.editDescription') }));
    const editor = () => screen.getByRole('textbox', { name: t('task.description') }) as HTMLTextAreaElement;
    fireEvent.change(editor(), { target: { value: 'Half-written text' } });

    fireEvent.click(toLarge());
    await largeView();
    expect(editor().value).toBe('Half-written text');

    fireEvent.click(toQuick());
    await quickView();
    expect(editor().value).toBe('Half-written text');
  });

  it('keeps the draft of a comment through the switch', async () => {
    renderBoard(`/p/AC/tasks/${ownerTask}`);
    await quickView();
    const box = (await screen.findByRole('textbox', {
      name: t('task.comments.label'),
    })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'A comment' } });
    fireEvent.click(toLarge());
    await largeView();
    expect(
      (screen.getByRole('textbox', { name: t('task.comments.label') }) as HTMLTextAreaElement).value,
    ).toBe('A comment');
  });

  it('reads the reading column first in the window with two columns, and the quick order elsewhere', async () => {
    const order = async () => {
      const dialog = await screen.findByRole('dialog', { name: t('task.drawerLabel') });
      const timeline = within(dialog).getByRole('heading', { name: t('task.timeline') });
      const properties = within(dialog).getByText(t('taskLifecycle.assignee'));
      return timeline.compareDocumentPosition(properties) & Node.DOCUMENT_POSITION_FOLLOWING
        ? 'timeline'
        : 'props';
    };
    // Narrow window: the order of the quick view, the properties first.
    const narrow = renderBoard(`/p/AC/tasks/${ownerTask}?size=large`);
    expect(await order()).toBe('props');
    narrow.unmount();
    screenIs((query) => query.includes('min-width: 1104px'));
    renderBoard(`/p/AC/tasks/${ownerTask}?size=large`);
    expect(await order()).toBe('timeline');
  });

  it('has no large window on a phone: no switch, and ?size=large does nothing', async () => {
    screenIs((query) => query.includes('max-width: 767px'));
    renderBoard(`/p/AC/tasks/${ownerTask}?size=large`);
    const drawer = await quickView();
    expect(within(drawer).queryByRole('button', { name: t('task.size.large') })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: t('task.size.quick') })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a way out above a card that cannot be shown', async () => {
    renderBoard('/p/AC/tasks/AC-9999?size=large');
    const window = await largeView();
    fireEvent.click(await within(window).findByRole('button', { name: t('common.close') }));
    await waitFor(() => expect(where()).toBe('/p/AC'));
  });
});

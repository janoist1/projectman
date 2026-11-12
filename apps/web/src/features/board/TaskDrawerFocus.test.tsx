import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { Route, Routes, useNavigate } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

/** Stands for the link of a card inside the open drawer: it leads to another card in the same place. */
function ToOtherCard({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      other card
    </button>
  );
}

/** The board and the open card as the app mounts them: the page region is the layout's `<main id="main">`. */
function renderBoard(route: string) {
  const project = mockProject();
  // StrictMode like the app: the drawer's effects run twice, and the opener must survive that.
  renderUi(
    <StrictMode>
      <ToastProvider>
        <ProjectContext.Provider value={project.context}>
          <AttachmentUploadsProvider>
            <ToOtherCard to="/p/AC/tasks/AC-21" />
            <main id="main" tabIndex={-1}>
              <Routes>
                <Route path="/p/:key" element={<BoardPage />}>
                  <Route path="tasks/:taskKey/*" element={<TaskDrawer />} />
                </Route>
              </Routes>
            </main>
          </AttachmentUploadsProvider>
        </ProjectContext.Provider>
      </ToastProvider>
    </StrictMode>,
    { route },
  );
  return project;
}

const quickView = () => screen.findByRole('complementary', { name: t('task.drawerLabel') });
const closeButton = (drawer: HTMLElement) => within(drawer).getByRole('button', { name: t('common.close') });
const gone = () =>
  waitFor(() => expect(screen.queryByRole('complementary', { name: t('task.drawerLabel') })).toBeNull());

/** What a browser does when a card link is clicked: the link takes the focus, then the drawer opens. */
async function openFromBoard(project: ReturnType<typeof mockProject>, taskKey: string) {
  const [link] = await findBoardCardLinks(project.backend.findTask(taskKey)!.title);
  link!.focus();
  fireEvent.click(link!);
  return link!;
}

describe('the focus when the card drawer closes (PM-1358)', () => {
  it('goes back to the card link the drawer was opened from, on ✕ and on Escape', async () => {
    const project = renderBoard('/p/AC');
    const link = await openFromBoard(project, 'AC-20');
    fireEvent.click(closeButton(await quickView()));
    await gone();
    await waitFor(() => expect(document.activeElement).toBe(link));

    link.focus();
    fireEvent.click(link);
    await quickView();
    fireEvent.keyDown(document, { key: 'Escape' });
    await gone();
    await waitFor(() => expect(document.activeElement).toBe(link));
  });

  it('keeps the first opener when the user moves on to another card inside the drawer', async () => {
    const project = renderBoard('/p/AC');
    const link = await openFromBoard(project, 'AC-20');
    await quickView();
    fireEvent.click(screen.getByRole('button', { name: 'other card' }));
    await screen.findByRole('heading', { name: new RegExp(project.backend.findTask('AC-21')!.title) });
    fireEvent.click(closeButton(await quickView()));
    await gone();
    await waitFor(() => expect(document.activeElement).toBe(link));
  });

  it('goes to the closed card’s own link when the drawer was opened by its address', async () => {
    const project = renderBoard('/p/AC/tasks/AC-20');
    fireEvent.click(closeButton(await quickView()));
    await gone();
    const [link] = await findBoardCardLinks(project.backend.findTask('AC-20')!.title);
    await waitFor(() => expect(document.activeElement).toBe(link));
  });

  it('goes to the page region when the card has no link on the page any more', async () => {
    renderBoard('/p/AC/tasks/AC-9999');
    fireEvent.click(closeButton(await quickView()));
    await gone();
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('main')));
  });
});

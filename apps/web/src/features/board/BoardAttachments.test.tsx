import { useQueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTACHMENT_BYTES, routes } from '@projectman/shared';
import { Route, Routes } from 'react-router';
import { applyServerEvent } from '../../api/cache';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import { ProjectContext } from '../../app/contexts';
import type { ProjectContextValue } from '../../app/contexts';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { renderUi } from '../../test/render';
import { AttachmentUploadsProvider } from './attachmentUploads';
import { BoardPage } from './BoardPage';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

type Project = ReturnType<typeof mockProject>;

/** Feeds the backend's websocket events into the query cache, like the app's socket provider. */
function LiveEvents({ backend }: { backend: Project['backend'] }) {
  const client = useQueryClient();
  useEffect(() => {
    const connection = {
      deliver: (event: Parameters<typeof applyServerEvent>[1]) => applyServerEvent(client, event),
    };
    const disconnect = backend.connect(connection);
    backend.handleCommand(connection, { type: 'subscribe_project', projectKey: 'AC' });
    return disconnect;
  }, [backend, client]);
  return null;
}

/**
 * The board and the open card as the app mounts them: the notices (the toast provider sits above
 * the project, as in the app) and the project-wide upload queue around them.
 */
function renderBoard(project: Project, route: string, overrides: Partial<ProjectContextValue> = {}) {
  return renderUi(
    <ToastProvider>
      <ProjectContext.Provider value={{ ...project.context, ...overrides }}>
        <AttachmentUploadsProvider>
          <LiveEvents backend={project.backend} />
          <Routes>
            <Route path="/p/:key" element={<BoardPage />}>
              <Route path="tasks/:taskKey" element={<TaskDrawer />} />
            </Route>
            <Route path="/" element={<BoardPage />} />
          </Routes>
        </AttachmentUploadsProvider>
      </ProjectContext.Provider>
    </ToastProvider>,
    { route },
  );
}

/** A drag with files, as the browser reports it while the files are still outside the page. */
const dragOf = (...files: File[]) => ({
  types: ['Files'],
  files,
  items: files.map(() => ({})),
  dropEffect: '',
});

const makeFile = (name: string, type = 'image/png', size?: number): File => {
  const file = new File(['content'], name, { type });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
};

const cardLink = (project: Project, key: string) =>
  screen.findByRole('link', { name: new RegExp(project.backend.findTask(key)!.title) });

const uploads = (project: Project, taskKey?: string) =>
  project.requests.filter(
    (request) =>
      request.method === 'POST' &&
      request.path.endsWith('/attachments') &&
      (taskKey === undefined || request.path === routes.taskAttachments('AC', taskKey)),
  );

/** The viewer is a member of the mock project with this access level. */
function asAccess(project: Project, access: 'viewer' | 'client' | 'developer') {
  return {
    me: {
      ...project.context.me,
      projects: [{ ...project.context.me.projects[0]!, access, roles: [] }],
    },
  };
}

describe('files dropped on a card of the board', () => {
  it('attaches the files to that card, with the same queue as the open card, and says so', async () => {
    const project = mockProject();
    renderBoard(project, '/');
    const link = await cardLink(project, 'AC-20');
    const drag = dragOf(makeFile('shot.png'));
    expect(fireEvent.drop(link, { dataTransfer: drag })).toBe(false);
    await screen.findByText(t('attachments.attached', { fileName: 'shot.png' }));
    expect(uploads(project)).toHaveLength(1);
    expect(uploads(project, 'AC-20')).toHaveLength(1);
    expect(project.backend.attachments.map((entry) => [entry.taskKey, entry.fileName])).toEqual([
      ['AC-20', 'shot.png'],
    ]);
  });

  it('shows a chip on the card while the files are on their way, then one notice for all of them', async () => {
    const project = mockProject();
    renderBoard(project, '/');
    const link = await cardLink(project, 'AC-20');
    fireEvent.drop(link, { dataTransfer: dragOf(makeFile('one.png'), makeFile('two.txt', 'text/plain')) });
    expect(within(link).getByText(t('attachments.uploadingCount', { count: 2 }))).toBeTruthy();
    await screen.findByText(t('attachments.attachedMany', { count: 2 }));
    expect(within(link).queryByRole('status')).toBeNull();
    expect(project.backend.attachments).toHaveLength(2);
  });

  it('names the file and the reason when it cannot be attached', async () => {
    const project = mockProject();
    renderBoard(project, '/');
    const link = await cardLink(project, 'AC-20');
    const size = MAX_ATTACHMENT_BYTES + 1;
    fireEvent.drop(link, { dataTransfer: dragOf(makeFile('big.bin', 'application/octet-stream', size)) });
    await screen.findByText(
      t('attachments.attachFailed', {
        fileName: 'big.bin',
        reason: t('attachments.tooLarge', {
          size: formatBytes(size),
          max: formatBytes(MAX_ATTACHMENT_BYTES),
        }),
      }),
    );
    expect(uploads(project)).toHaveLength(0);
  });

  it('marks the card that takes the file while the drag is over it, and only that one', async () => {
    const project = mockProject();
    renderBoard(project, '/');
    const link = await cardLink(project, 'AC-20');
    const other = await cardLink(project, 'AC-17');
    const drag = dragOf(makeFile('shot.png'));
    expect(fireEvent.dragEnter(link, { dataTransfer: drag })).toBe(false);
    expect(link.getAttribute('data-file')).toBe('over');
    expect(within(link).getByText(t('attachments.dropActive'))).toBeTruthy();
    expect(other.getAttribute('data-file')).toBeNull();
    // Over the card, the board's own hint stays away.
    expect(screen.queryByText(t('attachments.boardHint'))).toBeNull();
    fireEvent.dragOver(link, { dataTransfer: drag });
    expect(drag.dropEffect).toBe('copy');
    fireEvent.dragLeave(link, { dataTransfer: drag });
    expect(link.getAttribute('data-file')).toBeNull();
  });

  it('does not take a dragged card, text or a link as files', async () => {
    const project = mockProject();
    renderBoard(project, '/');
    const link = await cardLink(project, 'AC-20');
    const card = link.parentElement!;
    const other = await cardLink(project, 'AC-17');
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '', types: ['text/plain'] };
    expect(fireEvent.dragEnter(other, { dataTransfer })).toBe(true);
    expect(other.getAttribute('data-file')).toBeNull();
    fireEvent.dragStart(card, {
      dataTransfer: { ...dataTransfer, types: ['application/x-projectman-task'] },
    });
    expect(
      fireEvent.dragEnter(other, {
        dataTransfer: { ...dataTransfer, types: ['application/x-projectman-task'] },
      }),
    ).toBe(true);
    expect(other.getAttribute('data-file')).toBeNull();
    expect(screen.queryByText(t('attachments.boardHint'))).toBeNull();
    expect(uploads(project)).toHaveLength(0);
  });

  it('refuses a card the person may not attach to: a red mark, and nothing is sent', async () => {
    const project = mockProject();
    renderBoard(project, '/', asAccess(project, 'viewer'));
    const link = await cardLink(project, 'AC-20');
    const drag = dragOf(makeFile('shot.png'));
    fireEvent.dragEnter(link, { dataTransfer: drag });
    expect(link.getAttribute('data-file')).toBe('denied');
    expect(within(link).getByText(t('attachments.dropDenied'))).toBeTruthy();
    // Cancelled with no effect: the browser does not open the file either.
    expect(fireEvent.dragOver(link, { dataTransfer: drag })).toBe(false);
    expect(drag.dropEffect).toBe('none');
    expect(fireEvent.drop(link, { dataTransfer: drag })).toBe(false);
    expect(link.getAttribute('data-file')).toBeNull();
    expect(uploads(project)).toHaveLength(0);
  });
});

describe('files dropped on the board but not on a card', () => {
  it('says where to drop them, takes nothing, and keeps the browser from opening the file', async () => {
    const project = mockProject();
    renderBoard(project, '/');
    await cardLink(project, 'AC-20');
    const column = screen.getByRole('region', { name: project.backend.config.pipeline.columns[0]!.name });
    const drag = dragOf(makeFile('shot.png'));
    fireEvent.dragEnter(column, { dataTransfer: drag });
    expect(screen.getByText(t('attachments.boardHint'))).toBeTruthy();
    expect(fireEvent.dragOver(column, { dataTransfer: drag })).toBe(false);
    expect(drag.dropEffect).toBe('none');
    expect(fireEvent.drop(column, { dataTransfer: drag })).toBe(false);
    expect(screen.queryByText(t('attachments.boardHint'))).toBeNull();
    expect(uploads(project)).toHaveLength(0);
  });

  it('leaves a drag of text alone', async () => {
    const project = mockProject();
    renderBoard(project, '/');
    await cardLink(project, 'AC-20');
    const column = screen.getByRole('region', { name: project.backend.config.pipeline.columns[0]!.name });
    const text = { types: ['text/plain'], files: [], items: [], dropEffect: '' };
    expect(fireEvent.dragOver(column, { dataTransfer: text })).toBe(true);
    expect(screen.queryByText(t('attachments.boardHint'))).toBeNull();
  });
});

describe('the open card takes files too', () => {
  it('marks the whole drawer with the card title, and takes the drop', async () => {
    const project = mockProject();
    renderBoard(project, '/p/AC/tasks/AC-20');
    const drawer = await screen.findByRole('complementary', { name: t('task.drawerLabel') });
    await within(drawer).findByRole('region', { name: t('attachments.title') });
    const title = project.backend.findTask('AC-20')!.title;
    const drag = dragOf(makeFile('shot.png'));
    // On the title, far from the attachments section.
    const heading = within(drawer).getAllByText(title)[0]!;
    expect(fireEvent.dragEnter(heading, { dataTransfer: drag })).toBe(false);
    const overlay = within(drawer).getByText(t('attachments.dropActive')).parentElement!;
    expect(within(overlay).getByText(title)).toBeTruthy();
    // The board under the drawer is not told: it shows no hint of its own.
    expect(screen.queryByText(t('attachments.boardHint'))).toBeNull();
    expect(fireEvent.drop(heading, { dataTransfer: drag })).toBe(false);
    await within(drawer).findByText(t('timeline.attachmentAdded', { fileName: 'shot.png' }));
    expect(screen.queryByText(t('attachments.dropActive'))).toBeNull();
    expect(uploads(project, 'AC-20')).toHaveLength(1);
  });

  it('says so when the person may not attach, and sends nothing', async () => {
    const project = mockProject();
    renderBoard(project, '/p/AC/tasks/AC-20', asAccess(project, 'viewer'));
    const drawer = await screen.findByRole('complementary', { name: t('task.drawerLabel') });
    await within(drawer).findByRole('region', { name: t('attachments.title') });
    const drag = dragOf(makeFile('shot.png'));
    const heading = within(drawer).getAllByText(project.backend.findTask('AC-20')!.title)[0]!;
    fireEvent.dragEnter(heading, { dataTransfer: drag });
    expect(within(drawer).getByText(t('attachments.dropDenied'))).toBeTruthy();
    expect(fireEvent.drop(heading, { dataTransfer: drag })).toBe(false);
    expect(uploads(project)).toHaveLength(0);
  });

  it('shows what was dropped on the card on the board, and keeps it going when the card is opened', async () => {
    const project = mockProject();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (path, init) => {
      if (init?.method === 'POST') await held;
      return real(path, init);
    });
    renderBoard(project, '/');
    const link = await cardLink(project, 'AC-20');
    fireEvent.drop(link, { dataTransfer: dragOf(makeFile('slow.png')) });
    expect(within(link).getByText(t('attachments.uploading'))).toBeTruthy();
    fireEvent.click(link);
    const drawer = await screen.findByRole('complementary', { name: t('task.drawerLabel') });
    // The file is in the open card's queue.
    await within(drawer).findByLabelText(t('attachments.uploadingLabel', { fileName: 'slow.png' }));
    release();
    await waitFor(() => expect(project.backend.attachments).toHaveLength(1));
    await within(drawer).findByText(t('timeline.attachmentAdded', { fileName: 'slow.png' }));
  });
});

describe('the cover of a card', () => {
  const thumbnailOf = (container: HTMLElement, key: string, id: string) =>
    container.querySelector<HTMLImageElement>(`img[src="${routes.attachmentThumbnail('AC', key, id)}"]`);

  it('is the small preview of the first image, lazy and decorative', async () => {
    const project = mockProject();
    const first = project.backend.addAttachment('AC-20', { name: 'a.png', size: 10, type: 'image/png' });
    project.backend.addAttachment('AC-20', { name: 'b.png', size: 10, type: 'image/png' });
    project.backend.addAttachment('AC-17', { name: 'plan.pdf', size: 10, type: 'application/pdf' });
    const view = renderBoard(project, '/');
    await cardLink(project, 'AC-20');
    const image = thumbnailOf(view.container, 'AC-20', first.id)!;
    expect(image).toBeTruthy();
    expect(image.getAttribute('alt')).toBe('');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('decoding')).toBe('async');
    // One cover per card, never the full image and never a PDF.
    expect(view.container.querySelectorAll('img')).toHaveLength(1);
    expect(view.container.querySelector(`img[src*="/content"]`)).toBeNull();
  });

  it('leaves nothing behind when the preview does not load', async () => {
    const project = mockProject();
    const first = project.backend.addAttachment('AC-20', { name: 'a.png', size: 10, type: 'image/png' });
    const view = renderBoard(project, '/');
    await cardLink(project, 'AC-20');
    fireEvent.error(thumbnailOf(view.container, 'AC-20', first.id)!);
    expect(view.container.querySelector('img')).toBeNull();
  });

  it('follows the first image as files come and go', async () => {
    const project = mockProject();
    const view = renderBoard(project, '/');
    await cardLink(project, 'AC-20');
    expect(view.container.querySelector('img')).toBeNull();
    const first = project.backend.addAttachment('AC-20', { name: 'a.png', size: 10, type: 'image/png' });
    await waitFor(() => expect(thumbnailOf(view.container, 'AC-20', first.id)).toBeTruthy());
    const second = project.backend.addAttachment('AC-20', { name: 'b.png', size: 10, type: 'image/png' });
    expect(thumbnailOf(view.container, 'AC-20', first.id)).toBeTruthy();
    expect(thumbnailOf(view.container, 'AC-20', second.id)).toBeNull();
    project.backend.removeAttachment(first.id);
    await waitFor(() => expect(thumbnailOf(view.container, 'AC-20', second.id)).toBeTruthy());
    expect(thumbnailOf(view.container, 'AC-20', first.id)).toBeNull();
    project.backend.removeAttachment(second.id);
    await waitFor(() => expect(view.container.querySelector('img')).toBeNull());
  });

  it('is marked in the list of the open card', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-20', { name: 'plan.pdf', size: 10, type: 'application/pdf' });
    const first = project.backend.addAttachment('AC-20', { name: 'a.png', size: 10, type: 'image/png' });
    project.backend.addAttachment('AC-20', { name: 'b.png', size: 10, type: 'image/png' });
    renderBoard(project, '/p/AC/tasks/AC-20');
    const list = await screen.findByRole('list', { name: t('attachments.listLabel') });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => within(row).queryByText(t('attachments.cover')) !== null)).toEqual([
      false,
      true,
      false,
    ]);
    expect(first.id).toBeTruthy();
  });

  it('is a small thumbnail on the phone', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    const project = mockProject();
    const first = project.backend.addAttachment('AC-20', { name: 'a.png', size: 10, type: 'image/png' });
    const view = renderBoard(project, '/');
    await cardLink(project, 'AC-20');
    const image = thumbnailOf(view.container, 'AC-20', first.id)!;
    expect(image).toBeTruthy();
    expect(image.parentElement!.className).toMatch(/thumbnail/);
  });
});

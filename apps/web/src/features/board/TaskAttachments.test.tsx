import { useQueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { Link, Route, Routes } from 'react-router';
import { MAX_ATTACHMENT_BYTES, routes } from '@projectman/shared';
import type { HumanAccess } from '@projectman/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { applyServerEvent } from '../../api/cache';
import { setFetchImplementation } from '../../api/client';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

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

const drawerFor = (project: Project) => (
  <Routes>
    <Route
      path="/p/:key/tasks/:taskKey"
      element={
        <>
          <LiveEvents backend={project.backend} />
          <Link to="/p/AC/tasks/AC-19">other task</Link>
          <TaskDrawer />
        </>
      }
    />
  </Routes>
);

/** The viewer is another member of the mock project, with this access level. */
function actAs(project: Project, handle: string, access: HumanAccess) {
  project.backend.viewerHandle = handle;
  const member = project.backend.findMember(handle)!;
  member.role = access;
  return {
    myHandle: handle,
    isOwner: access === 'owner',
    can: {
      createTasks: ['owner', 'admin', 'developer'].includes(access),
      manageTeam: false,
      workInSessions: false,
    },
    me: {
      ...project.context.me,
      handles: { AC: handle },
      projects: [{ ...project.context.me.projects[0]!, access, roles: [] }],
    },
  };
}

function makeFile(name: string, type = 'text/plain', size?: number): File {
  const file = new File(['content'], name, { type });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

const choose = (...files: File[]) =>
  fireEvent.change(screen.getByLabelText(t('attachments.inputLabel')), { target: { files } });

const section = () => screen.findByRole('region', { name: t('attachments.title') });

const uploads = (project: Project) =>
  project.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/attachments'));

const OWNER_ACTOR = { kind: 'human', handle: 'owner' } as const;

describe('attachments: list', () => {
  it('shows name, size, uploader and time, a download link, and no preview for other types', async () => {
    const project = mockProject();
    const html = project.backend.addAttachment('AC-20', { name: 'page.html', size: 2300, type: 'text/html' });
    const svg = project.backend.addAttachment('AC-20', {
      name: 'logo.svg',
      size: 800,
      type: 'image/svg+xml',
    });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    const list = within(await screen.findByRole('list', { name: t('attachments.listLabel') }));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.getByText('page.html')).toBeTruthy();
    expect(
      list.getByText((text) => text.startsWith(`${formatBytes(2300)} · ${t('common.you')} · `)),
    ).toBeTruthy();
    const download = list.getByRole('link', {
      name: t('attachments.downloadLabel', { fileName: 'page.html' }),
    });
    expect(download.getAttribute('href')).toBe(routes.attachmentDownload('AC', 'AC-20', html.id));
    expect(download.hasAttribute('download')).toBe(true);
    // HTML and SVG are download only: no image, no frame, no open link.
    const svgDownload = list.getByRole('link', {
      name: t('attachments.downloadLabel', { fileName: 'logo.svg' }),
    });
    expect(svgDownload.getAttribute('href')).toBe(routes.attachmentDownload('AC', 'AC-20', svg.id));
    expect(list.queryByRole('button', { name: /nagy méretben/ })).toBeNull();
    expect(list.queryAllByRole('link', { name: new RegExp(t('attachments.openPdf')) })).toHaveLength(0);
    expect(document.querySelector('iframe, embed, object, img[src*="/attachments/"]')).toBeNull();
  });

  it('shows a hostile file name as text only', async () => {
    const project = mockProject();
    const name = '<img src=x onerror=alert(1)>.txt';
    project.backend.addAttachment('AC-20', { name, size: 10, type: 'text/plain' });
    const { container } = project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    const list = within(await screen.findByRole('list', { name: t('attachments.listLabel') }));
    expect(list.getByText(name)).toBeTruthy();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    // The same name on the timeline.
    expect(await screen.findByText(t('timeline.attachmentAdded', { fileName: name }))).toBeTruthy();
  });

  it('says so when a task has none', async () => {
    const project = mockProject();
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    expect(await screen.findByText(t('attachments.none'))).toBeTruthy();
  });
});

describe('attachments: preview', () => {
  it('shows a small lazy thumbnail and opens the image large, closing with the dialog', async () => {
    const project = mockProject();
    const image = project.backend.addAttachment('AC-20', { name: 'shot.png', size: 5000, type: 'image/png' });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    const open = await screen.findByRole('button', {
      name: t('attachments.previewLabel', { fileName: 'shot.png' }),
    });
    const thumb = open.querySelector('img')!;
    expect(thumb.getAttribute('src')).toBe(routes.attachmentContent('AC', 'AC-20', image.id));
    expect(thumb.getAttribute('loading')).toBe('lazy');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog');
    const large = within(dialog).getByAltText(t('attachments.previewOf', { fileName: 'shot.png' }));
    expect(large.getAttribute('src')).toBe(routes.attachmentContent('AC', 'AC-20', image.id));
    // Escape is the dialog's cancel: it closes the view and leaves the drawer open.
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('complementary')).toBeTruthy();
  });

  it('closes an open view when the file is deleted by someone else', async () => {
    const project = mockProject();
    const image = project.backend.addAttachment('AC-20', { name: 'shot.png', size: 5000, type: 'image/png' });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    fireEvent.click(
      await screen.findByRole('button', { name: t('attachments.previewLabel', { fileName: 'shot.png' }) }),
    );
    await screen.findByRole('dialog');
    project.backend.removeAttachment(image.id);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('shot.png')).toBeNull();
  });

  it('opens a PDF in a new tab from the protected route, never inside the page', async () => {
    const project = mockProject();
    const pdf = project.backend.addAttachment('AC-20', {
      name: 'spec.pdf',
      size: 90_000,
      type: 'application/pdf',
    });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    const link = await screen.findByRole('link', {
      name: t('attachments.openPdfLabel', { fileName: 'spec.pdf' }),
    });
    expect(link.getAttribute('href')).toBe(routes.attachmentContent('AC', 'AC-20', pdf.id));
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(document.querySelector('iframe, embed, object')).toBeNull();
    expect(
      screen.getByRole('link', { name: t('attachments.downloadLabel', { fileName: 'spec.pdf' }) }),
    ).toBeTruthy();
  });
});

describe('attachments: upload', () => {
  it('sends one multipart request per file and lists them', async () => {
    const project = mockProject();
    const base = createMockFetch(project.backend, project.requests);
    const headers: string[][] = [];
    setFetchImplementation((path, init) => {
      if (init?.body instanceof FormData)
        headers.push(Object.keys(init.headers ?? {}).map((n) => n.toLowerCase()));
      return base(path, init);
    });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText(t('attachments.none'));
    const a = makeFile('a.txt');
    const b = makeFile('b.png', 'image/png');
    choose(a, b);
    await screen.findByText('b.png');
    await screen.findByText('a.txt');
    const sent = uploads(project);
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.path).toBe(routes.taskAttachments('AC', 'AC-20'));
      expect(request.body).toBeInstanceOf(FormData);
    }
    // The browser writes the multipart content type with its boundary: the client sets none.
    expect(headers).toHaveLength(2);
    for (const names of headers) expect(names).not.toContain('content-type');
    expect(sent.map((request) => (request.body as FormData).get('file'))).toEqual([a, b]);
    // The timeline of the task shows the uploads (the detail was read again).
    expect(await screen.findByText(t('timeline.attachmentAdded', { fileName: 'a.txt' }))).toBeTruthy();
    expect(project.backend.attachments.map((entry) => entry.fileName).sort()).toEqual(['a.txt', 'b.png']);
  });

  it('takes a file of exactly 25 MB and refuses one byte more before any request', async () => {
    const project = mockProject();
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText(t('attachments.none'));
    choose(makeFile('limit.bin', 'application/octet-stream', MAX_ATTACHMENT_BYTES));
    await screen.findByText('limit.bin');
    expect(uploads(project)).toHaveLength(1);

    choose(makeFile('over.bin', 'application/octet-stream', MAX_ATTACHMENT_BYTES + 1));
    const message = t('attachments.tooLarge', {
      size: formatBytes(MAX_ATTACHMENT_BYTES + 1),
      max: formatBytes(MAX_ATTACHMENT_BYTES),
    });
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.getByText('over.bin')).toBeTruthy();
    expect(uploads(project)).toHaveLength(1);
    // Nothing to retry: the file is only dismissed.
    expect(
      screen.queryByRole('button', { name: t('attachments.retryLabel', { fileName: 'over.bin' }) }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: t('attachments.dismissLabel', { fileName: 'over.bin' }) }),
    );
    expect(screen.queryByText('over.bin')).toBeNull();
  });

  it('shows the server size refusal in plain language', async () => {
    const project = mockProject();
    const base = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (path, init) =>
      init?.method === 'POST' && init.body instanceof FormData
        ? new Response(
            JSON.stringify({
              error: { code: 'attachment_too_large', message: 'x', details: { maxBytes: 1 } },
            }),
            { status: 413, headers: { 'content-type': 'application/json' } },
          )
        : base(path, init),
    );
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText(t('attachments.none'));
    choose(makeFile('big.txt'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      t('attachments.uploadFailed', { reason: t('errors.codes.attachment_too_large') }),
    );
  });

  it('keeps the files that went through when another fails, and retries only the failed one', async () => {
    const project = mockProject();
    const base = createMockFetch(project.backend, project.requests);
    const calls: string[] = [];
    let failing = true;
    setFetchImplementation(async (path, init) => {
      const file = init?.body instanceof FormData ? init.body.get('file') : null;
      if (file instanceof File) {
        calls.push(file.name);
        if (file.name === 'bad.txt' && failing) {
          return new Response(
            JSON.stringify({ error: { code: 'attachment_storage_failed', message: 'x' } }),
            {
              status: 500,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
      }
      return base(path, init);
    });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText(t('attachments.none'));
    choose(makeFile('good.txt'), makeFile('bad.txt'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      t('attachments.uploadFailed', { reason: t('errors.codes.attachment_storage_failed') }),
    );
    await screen.findByText(t('timeline.attachmentAdded', { fileName: 'good.txt' }));
    expect(calls.sort()).toEqual(['bad.txt', 'good.txt']);

    failing = false;
    fireEvent.click(
      screen.getByRole('button', { name: t('attachments.retryLabel', { fileName: 'bad.txt' }) }),
    );
    await screen.findByText(t('timeline.attachmentAdded', { fileName: 'bad.txt' }));
    expect(calls.sort()).toEqual(['bad.txt', 'bad.txt', 'good.txt']);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(project.backend.attachments.map((entry) => entry.fileName).sort()).toEqual([
      'bad.txt',
      'good.txt',
    ]);
  });

  it('shows a network failure and lets the file be sent again', async () => {
    const project = mockProject();
    const base = createMockFetch(project.backend, project.requests);
    let offline = true;
    setFetchImplementation(async (path, init) => {
      if (init?.body instanceof FormData && offline) throw new TypeError('Failed to fetch');
      return base(path, init);
    });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText(t('attachments.none'));
    choose(makeFile('later.txt'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      t('attachments.uploadFailed', { reason: t('errors.network') }),
    );
    offline = false;
    fireEvent.click(
      screen.getByRole('button', { name: t('attachments.retryLabel', { fileName: 'later.txt' }) }),
    );
    await screen.findByText(t('timeline.attachmentAdded', { fileName: 'later.txt' }));
  });

  it('runs at most three uploads at once, with a progress bar per running file', async () => {
    const project = mockProject();
    const base = createMockFetch(project.backend, project.requests);
    const held: Array<{ name: string; release: () => void }> = [];
    setFetchImplementation((path, init) => {
      const file = init?.body instanceof FormData ? init.body.get('file') : null;
      if (file instanceof File) {
        return new Promise<Response>((resolve) =>
          held.push({ name: file.name, release: () => resolve(base(path, init)) }),
        );
      }
      return base(path, init);
    });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText(t('attachments.none'));
    choose(...['1', '2', '3', '4', '5'].map((n) => makeFile(`f${n}.txt`)));
    await waitFor(() => expect(held).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(held).toHaveLength(3);
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
    expect(screen.getAllByText(new RegExp(t('attachments.queued')))).toHaveLength(2);

    held[0]!.release();
    await waitFor(() => expect(held).toHaveLength(4));
    held[1]!.release();
    await waitFor(() => expect(held).toHaveLength(5));
    held[2]!.release();
    held[3]!.release();
    held[4]!.release();
    await waitFor(() => expect(project.backend.attachments).toHaveLength(5));
    await waitFor(() => expect(screen.queryAllByRole('progressbar')).toHaveLength(0));
  });

  it('takes files dropped on the section, but not dragged text', async () => {
    const project = mockProject();
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    const region = await section();
    await screen.findByText(t('attachments.none'));
    // Text is not a file: the drop is left to the browser and to the field it lands on.
    expect(fireEvent.drop(region, { dataTransfer: { types: ['text/plain'], files: [], items: [] } })).toBe(
      true,
    );
    expect(uploads(project)).toHaveLength(0);

    const dropped = makeFile('dropped.txt');
    expect(fireEvent.dragEnter(region, { dataTransfer: { types: ['Files'], files: [], items: [] } })).toBe(
      false,
    );
    expect(screen.getByText(t('attachments.dropActive'))).toBeTruthy();
    expect(
      fireEvent.drop(region, { dataTransfer: { types: ['Files'], files: [dropped], items: [{}] } }),
    ).toBe(false);
    await screen.findByText(t('timeline.attachmentAdded', { fileName: 'dropped.txt' }));
    expect(screen.queryByText(t('attachments.dropActive'))).toBeNull();
  });
});

describe('attachments: paste', () => {
  const clipboard = (files: File[], text = '') => ({
    types: [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : [])],
    files,
    items: [],
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  });

  it('uploads an image pasted from the clipboard', async () => {
    const project = mockProject();
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText(t('attachments.none'));
    const image = makeFile('image.png', 'image/png');
    expect(fireEvent.paste(document.body, { clipboardData: clipboard([image]) })).toBe(false);
    await screen.findByText(t('timeline.attachmentAdded', { fileName: 'image.png' }));
    expect(((uploads(project)[0]!.body as FormData).get('file') as File).name).toBe('image.png');
  });

  it('leaves text and non-image files to the page', async () => {
    const project = mockProject();
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText(t('attachments.none'));
    expect(fireEvent.paste(document.body, { clipboardData: clipboard([], 'just text') })).toBe(true);
    expect(
      fireEvent.paste(document.body, { clipboardData: clipboard([makeFile('a.pdf', 'application/pdf')]) }),
    ).toBe(true);
    expect(uploads(project)).toHaveLength(0);
  });

  it('does not take a paste that carries text into a field being edited', async () => {
    const project = mockProject();
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText(t('attachments.none'));
    const field = (await screen.findAllByRole('textbox')).find((node) => node.tagName === 'TEXTAREA')!;
    const image = makeFile('image.png', 'image/png');
    // A page copied with its pictures: the text is for the field.
    expect(fireEvent.paste(field, { clipboardData: clipboard([image], 'Some copied text') })).toBe(true);
    expect(uploads(project)).toHaveLength(0);
    // A screenshot has no text: a text field cannot take it, so it is attached.
    expect(fireEvent.paste(field, { clipboardData: clipboard([image]) })).toBe(false);
    await screen.findByText(t('timeline.attachmentAdded', { fileName: 'image.png' }));
  });

  it('ignores a paste while a dialog is open', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-20', { name: 'shot.png', size: 5000, type: 'image/png' });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    fireEvent.click(
      await screen.findByRole('button', { name: t('attachments.previewLabel', { fileName: 'shot.png' }) }),
    );
    await screen.findByRole('dialog');
    expect(
      fireEvent.paste(document.body, { clipboardData: clipboard([makeFile('image.png', 'image/png')]) }),
    ).toBe(true);
    expect(uploads(project)).toHaveLength(0);
  });
});

describe('attachments: delete', () => {
  it('asks first, then deletes, and the timeline keeps the name and the actor', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-20', { name: 'old.txt', size: 100, type: 'text/plain' });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText('old.txt');
    fireEvent.click(
      screen.getByRole('button', { name: t('attachments.deleteLabel', { fileName: 'old.txt' }) }),
    );
    expect(project.requests.some((request) => request.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: t('attachments.deleteYes') }));
    await waitFor(() => expect(screen.queryByText('old.txt')).toBeNull());
    expect(project.backend.attachments).toHaveLength(0);
    const deleted = await screen.findByText(t('timeline.attachmentDeleted', { fileName: 'old.txt' }));
    // The actor of the event is named next to it.
    expect(within(deleted.closest('li')!).getByText(t('common.you'))).toBeTruthy();
    // The file's own addition stays on the timeline as well.
    expect(screen.getByText(t('timeline.attachmentAdded', { fileName: 'old.txt' }))).toBeTruthy();
  });

  it('can be cancelled', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-20', { name: 'keep.txt', size: 100, type: 'text/plain' });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText('keep.txt');
    fireEvent.click(
      screen.getByRole('button', { name: t('attachments.deleteLabel', { fileName: 'keep.txt' }) }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(
      screen.getByRole('button', { name: t('attachments.deleteLabel', { fileName: 'keep.txt' }) }),
    ).toBeTruthy();
    expect(project.requests.some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('shows a refused deletion in plain language and keeps the file', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-20', { name: 'kept.txt', size: 100, type: 'text/plain' });
    const base = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (path, init) =>
      init?.method === 'DELETE'
        ? new Response(JSON.stringify({ error: { code: 'insufficient_access', message: 'x' } }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })
        : base(path, init),
    );
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText('kept.txt');
    fireEvent.click(
      screen.getByRole('button', { name: t('attachments.deleteLabel', { fileName: 'kept.txt' }) }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('attachments.deleteYes') }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      t('attachments.deleteFailed', { reason: t('errors.codes.insufficient_access') }),
    );
    expect(screen.getByText('kept.txt')).toBeTruthy();
  });

  it('reads the list again when the file is already gone', async () => {
    const project = mockProject();
    const att = project.backend.addAttachment('AC-20', { name: 'gone.txt', size: 100, type: 'text/plain' });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText('gone.txt');
    // Someone else removes it just before the click: the list on screen is stale until it is read again.
    project.backend.attachments = project.backend.attachments.filter((entry) => entry.id !== att.id);
    fireEvent.click(
      screen.getByRole('button', { name: t('attachments.deleteLabel', { fileName: 'gone.txt' }) }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('attachments.deleteYes') }));
    await waitFor(() => expect(screen.queryByText('gone.txt')).toBeNull());
  });
});

describe('attachments: who may do what', () => {
  it('offers a viewer the list and downloads, but no upload, no paste and no delete', async () => {
    const project = mockProject();
    project.backend.addAttachment(
      'AC-20',
      { name: 'mine.txt', size: 10, type: 'text/plain' },
      { kind: 'human', handle: 'bence' },
    );
    const overrides = actAs(project, 'bence', 'viewer');
    project.render(drawerFor(project), '/p/AC/tasks/AC-20', overrides);
    await screen.findByText('mine.txt');
    // Not even an older upload of their own can be deleted.
    expect(screen.queryByRole('button', { name: t('attachments.chooseFiles') })).toBeNull();
    expect(screen.queryByLabelText(t('attachments.inputLabel'))).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(t('attachments.delete')) })).toBeNull();
    expect(
      screen.getByRole('link', { name: t('attachments.downloadLabel', { fileName: 'mine.txt' }) }),
    ).toBeTruthy();
    const image = makeFile('image.png', 'image/png');
    expect(
      fireEvent.paste(document.body, {
        clipboardData: { types: ['Files'], files: [image], items: [], getData: () => '' },
      }),
    ).toBe(true);
    expect(uploads(project)).toHaveLength(0);
    // The server refuses too (the fake applies the shared rule).
    expect(
      project.backend.handle(
        'POST',
        routes.taskAttachments('AC', 'AC-20'),
        (() => {
          const form = new FormData();
          form.append('file', image);
          return form;
        })(),
      ).status,
    ).toBe(403);
  });

  it('lets a developer delete only their own', async () => {
    const project = mockProject();
    project.backend.addAttachment(
      'AC-20',
      { name: 'theirs.txt', size: 10, type: 'text/plain' },
      { kind: 'human', handle: 'bence' },
    );
    project.backend.addAttachment('AC-20', { name: 'owners.txt', size: 10, type: 'text/plain' }, OWNER_ACTOR);
    project.render(drawerFor(project), '/p/AC/tasks/AC-20', actAs(project, 'bence', 'developer'));
    await screen.findByText('owners.txt');
    expect(
      screen.getByRole('button', { name: t('attachments.deleteLabel', { fileName: 'theirs.txt' }) }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: t('attachments.deleteLabel', { fileName: 'owners.txt' }) }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: t('attachments.chooseFiles') })).toBeTruthy();
  });

  it('lets an owner and an admin delete anyone’s', async () => {
    for (const access of ['owner', 'admin'] as const) {
      const project = mockProject();
      project.backend.addAttachment(
        'AC-20',
        { name: 'theirs.txt', size: 10, type: 'text/plain' },
        { kind: 'human', handle: 'bence' },
      );
      const overrides = access === 'owner' ? {} : actAs(project, 'kata', 'admin');
      const { unmount } = project.render(drawerFor(project), '/p/AC/tasks/AC-20', overrides);
      await screen.findByText('theirs.txt');
      expect(
        screen.getByRole('button', { name: t('attachments.deleteLabel', { fileName: 'theirs.txt' }) }),
      ).toBeTruthy();
      unmount();
    }
  });

  it('lets a client upload to a shared task and delete their own only', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-19', { name: 'ours.txt', size: 10, type: 'text/plain' }, OWNER_ACTOR);
    project.backend.addAttachment(
      'AC-19',
      { name: 'bence.txt', size: 10, type: 'text/plain' },
      { kind: 'human', handle: 'bence' },
    );
    project.render(drawerFor(project), '/p/AC/tasks/AC-19', actAs(project, 'bence', 'client'));
    await screen.findByText('ours.txt');
    expect(
      screen.getByRole('button', { name: t('attachments.deleteLabel', { fileName: 'bence.txt' }) }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: t('attachments.deleteLabel', { fileName: 'ours.txt' }) }),
    ).toBeNull();
    choose(makeFile('from-client.txt'));
    await screen.findByText(t('timeline.attachmentAdded', { fileName: 'from-client.txt' }));
    expect(project.backend.attachments.at(-1)).toMatchObject({
      fileName: 'from-client.txt',
      uploadedBy: { kind: 'human', handle: 'bence' },
    });
  });
});

describe('attachments: cover choice', () => {
  const png = { name: 'one.png', size: 100, type: 'image/png' };
  const jpg = { name: 'two.jpg', size: 100, type: 'image/jpeg' };
  const covers = (project: Project) =>
    project.requests.filter((request) => request.method === 'PUT' && request.path.endsWith('/cover'));
  const makeButton = (fileName: string) =>
    screen.queryByRole('button', { name: t('attachments.makeCoverLabel', { fileName }) });
  const hideButton = (fileName: string) =>
    screen.queryByRole('button', { name: t('attachments.hideCoverLabel', { fileName }) });

  it('marks the current cover with a chip and a hide button, and the other images with a choose button', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-20', png);
    project.backend.addAttachment('AC-20', jpg);
    project.backend.addAttachment('AC-20', { name: 'plan.pdf', size: 10, type: 'application/pdf' });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    const first = (await screen.findByText('one.png')).closest('li')!;
    expect(within(first).getByText(t('attachments.cover'))).toBeTruthy();
    expect(hideButton('one.png')).toBeTruthy();
    expect(makeButton('one.png')).toBeNull();
    expect(makeButton('two.jpg')).toBeTruthy();
    expect(hideButton('two.jpg')).toBeNull();
    // A PDF can never be a cover.
    expect(makeButton('plan.pdf')).toBeNull();
    expect(screen.queryByText(t('attachments.coverHidden'))).toBeNull();
  });

  it('sends the choice, takes the answered card into the cache and moves the chip', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-20', png);
    const second = project.backend.addAttachment('AC-20', jpg);
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText('two.jpg');
    fireEvent.click(makeButton('two.jpg')!);
    await waitFor(() => expect(hideButton('two.jpg')).toBeTruthy());
    expect(covers(project)).toHaveLength(1);
    expect(covers(project)[0]!.path).toBe(routes.taskCover('AC', 'AC-20'));
    expect(covers(project)[0]!.body).toEqual({ mode: 'pinned', attachmentId: second.id });
    expect(project.backend.findTask('AC-20')!.coverAttachmentId).toBe(second.id);
    const first = screen.getByText('one.png').closest('li')!;
    expect(within(first).queryByText(t('attachments.cover'))).toBeNull();
    expect(makeButton('one.png')).toBeTruthy();
  });

  it('hides the cover and says so, and keeps it hidden after another upload', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-20', png);
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText('one.png');
    fireEvent.click(hideButton('one.png')!);
    await screen.findByText(t('attachments.coverHidden'));
    expect(covers(project)[0]!.body).toEqual({ mode: 'hidden' });
    expect(project.backend.findTask('AC-20')!.coverAttachmentId).toBeUndefined();
    expect(screen.queryByText(t('attachments.cover'))).toBeNull();
    expect(makeButton('one.png')).toBeTruthy();

    choose(makeFile('later.png', 'image/png'));
    await screen.findByText('later.png');
    expect(project.backend.findTask('AC-20')!.coverAttachmentId).toBeUndefined();
    expect(screen.getByText(t('attachments.coverHidden'))).toBeTruthy();
    expect(screen.queryByText(t('attachments.cover'))).toBeNull();

    fireEvent.click(makeButton('later.png')!);
    await waitFor(() => expect(screen.queryByText(t('attachments.coverHidden'))).toBeNull());
    expect(hideButton('later.png')).toBeTruthy();
  });

  it('falls back to the first image when the chosen cover is deleted', async () => {
    const project = mockProject();
    const first = project.backend.addAttachment('AC-20', png);
    const second = project.backend.addAttachment('AC-20', jpg);
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText('two.jpg');
    fireEvent.click(makeButton('two.jpg')!);
    await waitFor(() => expect(project.backend.findTask('AC-20')!.coverAttachmentId).toBe(second.id));
    fireEvent.click(
      screen.getByRole('button', { name: t('attachments.deleteLabel', { fileName: 'two.jpg' }) }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('attachments.deleteYes') }));
    await waitFor(() => expect(screen.queryByText('two.jpg')).toBeNull());
    await waitFor(() => expect(hideButton('one.png')).toBeTruthy());
    expect(project.backend.findTask('AC-20')!.coverAttachmentId).toBe(first.id);
  });

  it('shows the answer of a refused choice in plain language', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-20', png);
    project.backend.addAttachment('AC-20', jpg);
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText('two.jpg');
    project.backend.attachments = project.backend.attachments.filter((entry) => entry.fileName !== 'two.jpg');
    fireEvent.click(makeButton('two.jpg')!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('errors.codes.cover_not_an_image'));
  });

  it('offers a viewer no cover buttons and no hint, and the server refuses too', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-20', png);
    const second = project.backend.addAttachment('AC-20', jpg);
    project.backend.covers.set('AC-20', { mode: 'hidden' });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20', actAs(project, 'bence', 'viewer'));
    await screen.findByText('one.png');
    expect(makeButton('one.png')).toBeNull();
    expect(makeButton('two.jpg')).toBeNull();
    expect(hideButton('one.png')).toBeNull();
    expect(screen.queryByText(t('attachments.coverHidden'))).toBeNull();
    expect(
      project.backend.handle('PUT', routes.taskCover('AC', 'AC-20'), {
        mode: 'pinned',
        attachmentId: second.id,
      }).status,
    ).toBe(403);
  });

  it('lets a client choose only on a shared card', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-19', png);
    project.backend.addAttachment('AC-19', jpg);
    project.render(drawerFor(project), '/p/AC/tasks/AC-19', actAs(project, 'bence', 'client'));
    await screen.findByText('two.jpg');
    expect(makeButton('two.jpg')).toBeTruthy();
    expect(hideButton('one.png')).toBeTruthy();
    // An internal card is not even visible to a client.
    expect(project.backend.handle('PUT', routes.taskCover('AC', 'AC-20'), { mode: 'hidden' }).status).toBe(
      404,
    );
  });
});

describe('attachments: live and lost access', () => {
  it('reads the list and the timeline again when the files change elsewhere', async () => {
    const project = mockProject();
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText(t('attachments.none'));
    const att = project.backend.addAttachment('AC-20', { name: 'remote.txt', size: 10, type: 'text/plain' });
    await screen.findByText('remote.txt');
    // The change is on the timeline too (a client reads the timeline, not the file list, for history).
    expect(await screen.findByText(t('timeline.attachmentAdded', { fileName: 'remote.txt' }))).toBeTruthy();
    project.backend.removeAttachment(att.id);
    await waitFor(() => expect(screen.queryByText('remote.txt')).toBeNull());
    expect(await screen.findByText(t('timeline.attachmentDeleted', { fileName: 'remote.txt' }))).toBeTruthy();
  });

  it('shows nothing of the files once the task is no longer shared with the client', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-19', { name: 'secret.txt', size: 10, type: 'text/plain' }, OWNER_ACTOR);
    project.backend.addAttachment('AC-19', { name: 'secret.png', size: 10, type: 'image/png' }, OWNER_ACTOR);
    project.render(drawerFor(project), '/p/AC/tasks/AC-19', actAs(project, 'bence', 'client'));
    await screen.findByText('secret.txt');
    expect(
      screen.getByRole('button', { name: t('attachments.previewLabel', { fileName: 'secret.png' }) }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: t('attachments.previewLabel', { fileName: 'secret.png' }) }),
    );
    await screen.findByRole('dialog');

    project.backend.updateTask('AC-19', { visibility: 'internal' });
    await waitFor(() => expect(screen.queryByText('secret.txt')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('img[src*="/attachments/"]')).toBeNull();
    expect(screen.queryByRole('button', { name: t('attachments.chooseFiles') })).toBeNull();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('clears the section when another task is opened', async () => {
    const project = mockProject();
    project.backend.addAttachment('AC-20', { name: 'first.txt', size: 10, type: 'text/plain' });
    project.render(drawerFor(project), '/p/AC/tasks/AC-20');
    await screen.findByText('first.txt');
    choose(makeFile('pending-a.txt', 'text/plain', MAX_ATTACHMENT_BYTES + 1));
    await screen.findByText('pending-a.txt');
    fireEvent.click(screen.getByRole('link', { name: 'other task' }));
    await screen.findByText(t('attachments.none'));
    expect(screen.queryByText('first.txt')).toBeNull();
    // The queue of the other task does not follow.
    expect(screen.queryByText('pending-a.txt')).toBeNull();
  });
});

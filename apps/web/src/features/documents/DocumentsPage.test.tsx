import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router';
import { documentOutline } from '@projectman/shared';
import type { HumanAccess } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { DocumentRoute, DocumentsRoute } from './routes';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function Pages() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/p/:projectKey/docs" element={<DocumentsRoute />} />
        <Route path="/p/:projectKey/docs/:slug" element={<DocumentRoute />} />
        <Route path="/p/:projectKey" element={<p>project home</p>} />
      </Routes>
      <Where />
    </ToastProvider>
  );
}

const where = () => screen.getByTestId('where').textContent;

const PLAN = [
  '# Terv',
  '',
  'Bevezető.',
  '',
  '## Áttekintés',
  '',
  'Szöveg.',
  '',
  '## Áttekintés',
  '',
  'Második.',
  '',
  '## Munka útja',
  '',
  'Végül.',
].join('\n');

function seeded() {
  const p = mockProject();
  const slug = p.backend.documents.seed({
    title: 'Projektterv',
    content: PLAN,
    by: 'devops',
    ageMinutes: 60,
  });
  p.backend.documents.seed({ title: 'Megállapodás', content: 'Röviden.', by: 'owner', ageMinutes: 5 });
  return { p, slug };
}

/** The same project, seen with another access level. */
function asAccess(p: ReturnType<typeof mockProject>, access: HumanAccess) {
  return { me: { ...p.context.me, projects: [{ ...p.context.me.projects[0]!, access }] } };
}

const nameOf = (p: ReturnType<typeof mockProject>, handle: string) =>
  p.backend.config.team.members.find((member) => member.handle === handle)!.displayName;

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

describe('the document list', () => {
  it('lists the newest change first, with who changed it', async () => {
    const { p } = seeded();
    p.render(<Pages />, '/p/AC/docs');
    const list = await screen.findByRole('list', { name: t('documents.listLabel') });
    const rows = within(list).getAllByRole('link');
    expect(rows[0]!.textContent).toContain('Megállapodás');
    expect(rows[1]!.textContent).toContain('Projektterv');
    expect(rows[1]!.textContent).toContain(t('documents.updatedBy', { name: nameOf(p, 'devops') }));
    expect(rows[1]!.getAttribute('href')).toBe('/p/AC/docs/projektterv');
    expect(screen.getByRole('button', { name: t('documents.new') })).toBeTruthy();
  });

  it('tells a viewer there is nothing yet and offers no new document', async () => {
    const p = mockProject();
    p.render(<Pages />, '/p/AC/docs', asAccess(p, 'viewer'));
    expect(await screen.findByText(t('documents.empty.bodyReadOnly'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('documents.new') })).toBeNull();
  });

  it('sends a client to the project home without asking for the documents', async () => {
    const { p } = seeded();
    p.render(<Pages />, '/p/AC/docs', asAccess(p, 'client'));
    expect(await screen.findByText('project home')).toBeTruthy();
    expect(p.requests.some((request) => request.path.includes('/documents'))).toBe(false);
  });
});

describe('writing a document', () => {
  it('creates one and opens it', async () => {
    const { p } = seeded();
    p.render(<Pages />, '/p/AC/docs?new=1');
    fireEvent.change(await screen.findByRole('textbox', { name: t('documents.editor.titleLabel') }), {
      target: { value: 'Új terv' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: t('documents.editor.contentLabel') }), {
      target: { value: '# Új terv\n\nSzöveg.' },
    });
    const create = screen.getByRole('button', { name: t('documents.editor.create') });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: new RegExp(t('documents.editor.messageLabel')) }), {
      target: { value: 'Első vázlat' },
    });
    fireEvent.click(create);
    await waitFor(() => expect(where()).toBe('/p/AC/docs/uj-terv'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Új terv' })).toBeTruthy();
    const post = p.requests.find(
      (request) => request.method === 'POST' && request.path.endsWith('/documents'),
    );
    expect(post?.body).toMatchObject({
      title: 'Új terv',
      content: '# Új terv\n\nSzöveg.',
      message: 'Első vázlat',
    });
  });

  it('saves against the version it read and keeps the slug when the title changes', async () => {
    const { p, slug } = seeded();
    p.render(<Pages />, `/p/AC/docs/${slug}?edit=1`);
    const title = await screen.findByRole('textbox', { name: t('documents.editor.titleLabel') });
    fireEvent.change(title, { target: { value: 'Projekt terv v2' } });
    fireEvent.change(screen.getByRole('textbox', { name: new RegExp(t('documents.editor.messageLabel')) }), {
      target: { value: 'Átnevezés' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('documents.editor.save') }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Projekt terv v2' })).toBeTruthy();
    const patch = p.requests.find((request) => request.method === 'PATCH');
    expect(patch?.path).toContain(`/documents/${slug}`);
    expect(patch?.body).toMatchObject({ title: 'Projekt terv v2', message: 'Átnevezés' });
    expect((patch?.body as { baseVersion: string }).baseVersion).toMatch(/^[0-9a-f]{40}$/);
    expect(where()).toBe(`/p/AC/docs/${slug}`);
  });

  it('keeps the own text when someone saved first', async () => {
    const { p, slug } = seeded();
    p.render(<Pages />, `/p/AC/docs/${slug}?edit=1`);
    const content = await screen.findByRole('textbox', { name: t('documents.editor.contentLabel') });
    fireEvent.change(content, { target: { value: 'Az én szövegem' } });
    p.backend.documents.changeElsewhere(slug, 'Más szövege', 'devops');
    fireEvent.change(screen.getByRole('textbox', { name: new RegExp(t('documents.editor.messageLabel')) }), {
      target: { value: 'Javítás' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('documents.editor.save') }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('documents.conflict.title'));
    fireEvent.click(screen.getByRole('button', { name: t('documents.conflict.reload') }));
    const kept = await screen.findByRole('region', { name: t('documents.conflict.kept') });
    expect((within(kept).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Az én szövegem');
    expect(
      (screen.getByRole('textbox', { name: t('documents.editor.contentLabel') }) as HTMLTextAreaElement)
        .value,
    ).toBe('Más szövege');
  });

  it('asks before throwing away unsaved changes', async () => {
    const { p, slug } = seeded();
    p.render(<Pages />, `/p/AC/docs/${slug}?edit=1`);
    fireEvent.change(await screen.findByRole('textbox', { name: t('documents.editor.titleLabel') }), {
      target: { value: 'Más cím' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: t('documents.editor.discardConfirm') }));
    await waitFor(() => expect(where()).toBe(`/p/AC/docs/${slug}`));
  });
});

describe('reading a document', () => {
  it('gives every heading the anchor the AI reads, even with accents and repeated titles', async () => {
    const { p, slug } = seeded();
    p.render(<Pages />, `/p/AC/docs/${slug}`);
    await screen.findByRole('heading', { level: 1, name: 'Projektterv' });
    const ids = [...document.querySelectorAll('h2, h3, h4, h5')].map((heading) => heading.id).filter(Boolean);
    expect(ids).toEqual(documentOutline(PLAN).map((heading) => heading.anchor));
    expect(ids).toContain('attekintes-2');
  });

  it('copies the reference of a section and keeps it in the address', async () => {
    const { p, slug } = seeded();
    const writeText = stubClipboard();
    p.render(<Pages />, `/p/AC/docs/${slug}`);
    fireEvent.click(
      await screen.findByRole('button', { name: t('documents.section.copy', { title: 'Munka útja' }) }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('projektterv#munka-utja'));
    expect(window.location.hash).toBe('#munka-utja');
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('jumps to the section a link names', async () => {
    const { p, slug } = seeded();
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    p.render(<Pages />, `/p/AC/docs/${slug}#munka-utja`);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(document.activeElement?.id).toBe('munka-utja');
  });

  it('shows the top and says so when the section is gone', async () => {
    const { p, slug } = seeded();
    p.render(<Pages />, `/p/AC/docs/${slug}#nincs-ilyen`);
    const note = await screen.findByText(t('documents.section.missingTitle', { section: 'nincs-ilyen' }));
    expect(note.closest('[role="status"]')).toBeTruthy();
  });

  it('says so when the document does not exist', async () => {
    const { p } = seeded();
    p.render(<Pages />, '/p/AC/docs/nincs-ilyen');
    expect(await screen.findByText(t('documents.notFound.title'))).toBeTruthy();
  });

  it('hides editing from a viewer', async () => {
    const { p, slug } = seeded();
    p.render(<Pages />, `/p/AC/docs/${slug}`, asAccess(p, 'viewer'));
    await screen.findByRole('heading', { level: 1, name: 'Projektterv' });
    expect(screen.queryByRole('button', { name: t('documents.edit') })).toBeNull();
    expect(screen.getByRole('button', { name: t('documents.history.title') })).toBeTruthy();
  });
});

describe('the history', () => {
  it('shows an older version and restores it as a new one', async () => {
    const { p, slug } = seeded();
    p.backend.documents.changeElsewhere(slug, '# Terv\n\nÚj szöveg.', 'devops');
    p.render(<Pages />, `/p/AC/docs/${slug}`);
    await screen.findByText('Új szöveg.');
    fireEvent.click(screen.getByRole('button', { name: t('documents.history.title') }));
    const drawer = await screen.findByRole('complementary', { name: t('documents.history.title') });
    expect(await within(drawer).findByText(t('documents.history.current'))).toBeTruthy();
    // The store's English default messages show in the UI language.
    expect(within(drawer).getByText(t('documents.history.created'))).toBeTruthy();
    expect(within(drawer).getByText(t('documents.history.updated'))).toBeTruthy();
    fireEvent.click(
      within(drawer).getAllByRole('button', { name: /Változat megnézése|View the version/ })[0]!,
    );
    await waitFor(() => expect(where()).toContain('?version='));
    expect(await screen.findByText('Bevezető.')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: t('documents.version.restore') })[0]!);
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: t('documents.version.restore') });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: new RegExp(t('documents.version.reasonLabel')) }),
      {
        target: { value: 'Rossz szerkesztés' },
      },
    );
    fireEvent.click(confirm);
    await waitFor(() => expect(where()).toBe(`/p/AC/docs/${slug}`));
    expect(await screen.findByText('Bevezető.')).toBeTruthy();
    const restore = p.requests.find((request) => request.path.endsWith('/restore'));
    expect(restore?.body).toMatchObject({
      version: expect.stringMatching(/^[0-9a-f]{40}$/),
      message: 'Rossz szerkesztés',
    });
  });
});

describe('deleting', () => {
  it('lets an owner delete after a confirmation, and goes back to the list', async () => {
    const { p, slug } = seeded();
    p.render(<Pages />, `/p/AC/docs/${slug}`);
    fireEvent.click(await screen.findByRole('button', { name: t('documents.more') }));
    fireEvent.click(await screen.findByRole('button', { name: t('documents.delete.action') }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: t('documents.delete.action') });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: new RegExp(t('documents.delete.reasonLabel')) }),
      {
        target: { value: 'Elavult' },
      },
    );
    fireEvent.click(confirm);
    await waitFor(() => expect(where()).toBe('/p/AC/docs'));
    const removal = p.requests.find((request) => request.method === 'DELETE');
    expect(removal?.path).toMatch(/baseVersion=[0-9a-f]{40}/);
    expect(removal?.path).toContain('message=');
  });

  it('offers a developer no deletion', async () => {
    const { p, slug } = seeded();
    p.render(<Pages />, `/p/AC/docs/${slug}`, asAccess(p, 'developer'));
    await screen.findByRole('heading', { level: 1, name: 'Projektterv' });
    expect(screen.getByRole('button', { name: t('documents.edit') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('documents.more') })).toBeNull();
  });
});

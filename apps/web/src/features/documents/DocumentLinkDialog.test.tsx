import { useState } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { DescriptionEditor } from '../../components/DescriptionEditor';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { useDocumentLinkTool } from './DocumentLinkDialog';

afterEach(() => {
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function Editor() {
  const [value, setValue] = useState('alpha beta');
  return (
    <DescriptionEditor
      label={t('task.description')}
      value={value}
      onChange={setValue}
      insertTool={useDocumentLinkTool()}
    />
  );
}

const PLAN = [
  '# Terv',
  '',
  '## Áttekintés',
  '',
  'Szöveg.',
  '',
  '### Részlet',
  '',
  '## Munka útja',
  '',
  'Végül.',
].join('\n');

function seeded() {
  const p = mockProject();
  p.backend.documents.seed({ title: 'Projektterv', content: PLAN, by: 'devops', ageMinutes: 60 });
  p.backend.documents.seed({ title: 'Megállapodás', content: 'Röviden.', by: 'owner', ageMinutes: 5 });
  return p;
}

const textarea = () => screen.getByLabelText(t('task.description')) as HTMLTextAreaElement;
const openPicker = () => fireEvent.click(screen.getByRole('button', { name: t('editor.document') }));
const documentSelect = () => screen.getByLabelText(t('documentLink.document')) as HTMLSelectElement;
const sectionSelect = () => screen.getByLabelText(t('documentLink.section')) as HTMLSelectElement;

describe('the document link picker', () => {
  it('links the chosen section over the selection, and previews exactly what it inserts', async () => {
    seeded().render(<Editor />, '/p/AC');
    textarea().setSelectionRange(6, 10);
    openPicker();
    await screen.findByLabelText(t('documentLink.document'));
    // The list is sorted by title; the first document has no sections.
    expect(await screen.findByText(t('documentLink.noSections'))).toBeTruthy();
    fireEvent.change(documentSelect(), { target: { value: 'projektterv' } });
    await waitFor(() => expect(sectionSelect().disabled).toBe(false));
    expect([...sectionSelect().options].map((option) => option.value)).toEqual([
      '',
      'terv',
      'attekintes',
      'reszlet',
      'munka-utja',
    ]);
    fireEvent.change(sectionSelect(), { target: { value: 'munka-utja' } });
    expect(document.querySelector('code')?.textContent).toBe('[beta](doc:projektterv#munka-utja)');
    fireEvent.click(screen.getByRole('button', { name: t('documentLink.insert') }));
    expect(textarea().value).toBe('alpha [beta](doc:projektterv#munka-utja)');
    expect(screen.queryByLabelText(t('documentLink.document'))).toBeNull();
  });

  it('names the link after the document and section when nothing is selected, and links the whole document', async () => {
    seeded().render(<Editor />, '/p/AC');
    openPicker();
    await screen.findByLabelText(t('documentLink.document'));
    fireEvent.change(documentSelect(), { target: { value: 'projektterv' } });
    await waitFor(() => expect(sectionSelect().disabled).toBe(false));
    expect(document.querySelector('code')?.textContent).toBe('[Projektterv](doc:projektterv)');
    fireEvent.change(sectionSelect(), { target: { value: 'attekintes' } });
    expect(document.querySelector('code')?.textContent).toBe(
      '[Projektterv › Áttekintés](doc:projektterv#attekintes)',
    );
  });

  it('leaves the text alone when cancelled', async () => {
    seeded().render(<Editor />, '/p/AC');
    openPicker();
    await screen.findByLabelText(t('documentLink.document'));
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(textarea().value).toBe('alpha beta');
    expect(screen.queryByLabelText(t('documentLink.document'))).toBeNull();
  });

  it('tells an empty project so, offers a new document and cannot insert', async () => {
    mockProject().render(<Editor />, '/p/AC');
    openPicker();
    expect(await screen.findByText(t('documentLink.empty'))).toBeTruthy();
    expect(screen.getByRole('link', { name: t('documentLink.newDocument') }).getAttribute('href')).toBe(
      '/p/AC/docs?new=1',
    );
    expect(
      (screen.getByRole('button', { name: t('documentLink.insert') }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows a failed load with a retry that loads the list', async () => {
    const p = seeded();
    const backendFetch = createMockFetch(p.backend);
    let failures = 1;
    // The first request for the list fails; the rest go to the in-memory backend.
    setFetchImplementation(async (path, init) =>
      String(path).endsWith('/documents') && failures-- > 0
        ? // A refusal is final (no retries), so the failure shows at once.
          new Response(JSON.stringify({ code: 'forbidden', message: 'Failed' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })
        : backendFetch(String(path), init),
    );
    p.render(<Editor />, '/p/AC');
    openPicker();
    expect(await screen.findByText(t('documentLink.failed'))).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('documentLink.retry') }));
    expect(await screen.findByLabelText(t('documentLink.document'))).toBeTruthy();
  });

  it('has no button for a viewer who may not read documents', () => {
    const p = seeded();
    p.render(<Editor />, '/p/AC', {
      me: { ...p.context.me, projects: [{ ...p.context.me.projects[0]!, access: 'client' }] },
    });
    expect(screen.queryByRole('button', { name: t('editor.document') })).toBeNull();
  });
});

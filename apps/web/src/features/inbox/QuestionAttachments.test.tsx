import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { routes } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { formatBytes } from '../../i18n/format';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { attachmentQuestion, attachmentQuestionFiles, plainLanguageQuestion } from '../../mocks/fixtures';
import { mockIndexes, renderUi } from '../../test/render';
import { InboxCard } from './InboxCard';
import { QuestionAttachments } from './QuestionAttachments';

const { members, pipeline } = mockIndexes();

const fileOf = (id: string) => attachmentQuestionFiles.find((file) => file.id === id)!;
const group = () => screen.getByRole('group', { name: t('inbox.attachments.title') });
const tile = (name: string) => within(group()).getByRole('link', { name }) as HTMLAnchorElement;

function renderQuestion(entry = attachmentQuestion()) {
  return renderUi(<QuestionAttachments item={entry} projectKey="AC" />);
}

describe('QuestionAttachments', () => {
  it('opens an image in the large view and returns the focus to its tile on close', async () => {
    renderQuestion();
    const image = fileOf('att_aq0000image1');
    const open = within(group()).getByRole('button', {
      name: t('attachments.previewLabel', { fileName: image.fileName }),
    });
    open.focus();
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog');
    const large = within(dialog).getByAltText(t('attachments.previewOf', { fileName: image.fileName }));
    expect(large.getAttribute('src')).toBe(routes.attachmentContent('AC', 'AC-22', image.id));
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it('shows the failed image in its place, with the hint', async () => {
    renderQuestion();
    fireEvent.click(
      within(group()).getByRole('button', {
        name: t('attachments.previewLabel', { fileName: 'kosar-hiba.png' }),
      }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.error(within(dialog).getByRole('img'));
    const status = within(dialog).getByRole('status');
    expect(within(status).getByText(t('attachments.imageFailed'))).toBeTruthy();
    expect(within(status).getByText(t('attachments.imageFailedHint'))).toBeTruthy();
    expect(within(dialog).queryByRole('img')).toBeNull();
  });

  it('opens a PDF in a new tab from the protected route of its own card', () => {
    renderQuestion();
    const pdf = fileOf('att_aq0000pdf001');
    const link = tile(t('attachments.openPdfLabel', { fileName: pdf.fileName }));
    expect(link.getAttribute('href')).toBe(routes.attachmentContent('AC', 'AC-22', pdf.id));
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.textContent).toContain(formatBytes(pdf.size));
  });

  it('downloads a HTML file, never opening it, from the route of its own card', () => {
    renderQuestion();
    const html = fileOf('att_aq0000html01');
    const link = tile(t('attachments.downloadLabel', { fileName: html.fileName }));
    expect(link.getAttribute('href')).toBe(routes.attachmentDownload('AC', 'AC-22', html.id));
    expect(link.hasAttribute('download')).toBe(true);
    expect(link.getAttribute('target')).toBeNull();
  });

  it('uses the route and the label of the parent card for a file of the parent', () => {
    renderQuestion();
    const parent = fileOf('att_aq0000pdf002');
    const link = tile(
      t('attachments.openPdfLabel', { fileName: parent.fileName }) +
        t('inbox.attachments.fromCard', { key: 'AC-20' }),
    );
    expect(link.getAttribute('href')).toBe(routes.attachmentContent('AC', 'AC-20', parent.id));
    expect(within(link).getByText('AC-20')).toBeTruthy();
    // The question's own files carry no card key.
    const own = tile(t('attachments.openPdfLabel', { fileName: 'merespecifikacio.pdf' }));
    expect(within(own).queryByText('AC-22')).toBeNull();
  });

  it('shows a deleted file as plain text without a link, saying it is gone', () => {
    renderQuestion();
    const label = t('inbox.attachments.goneLabel', { fileName: 'regi-terv.png' });
    const gone = within(group()).getByText(label).closest('span[title]') as HTMLElement;
    expect(gone.tagName).toBe('SPAN');
    expect(gone.getAttribute('title')).toBe(t('inbox.attachments.goneTitle'));
    expect(within(gone).getByText(t('inbox.attachments.gone'))).toBeTruthy();
    expect(within(gone).queryByRole('link')).toBeNull();
    expect(within(gone).queryByRole('button')).toBeNull();
    // Five files: four tiles to open and the deleted one.
    expect(within(group()).getAllByRole('listitem')).toHaveLength(5);
    expect(within(group()).getAllByRole('link')).toHaveLength(3);
    expect(within(group()).getAllByRole('button')).toHaveLength(1);
  });

  it('shows no group on a question that names no file', () => {
    renderQuestion(plainLanguageQuestion());
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByText(t('inbox.attachments.title'))).toBeNull();
  });

  it('shows on the compact card, and stays on an answered question', () => {
    const entry = attachmentQuestion();
    renderUi(
      <InboxCard
        item={{ ...entry, state: 'resolved' }}
        members={members}
        myHandle="owner"
        pipeline={pipeline}
        compact
        onResolve={() => {}}
      />,
    );
    expect(group()).toBeTruthy();
    expect(within(group()).getAllByRole('listitem')).toHaveLength(5);
  });
});

describe('a question that names files in the fake backend', () => {
  it('turns a tile into "no longer available" after its file is deleted from the card', () => {
    const backend = new MockBackend();
    const file = (name: string, type: string) => {
      const { id, taskKey, fileName, size, mediaType, preview } = backend.addAttachment('AC-22', {
        name,
        size: 1200,
        type,
      });
      return { id, taskKey, fileName, size, mediaType, preview };
    };
    const html = file('jelentes.html', 'text/html');
    const pdf = file('merespecifikacio.pdf', 'application/pdf');
    const question = attachmentQuestion();
    backend.inbox.push({ ...question, payload: { ...question.payload, attachments: [html, pdf] } });
    backend.removeAttachment(html.id);
    const updated = backend.inbox.find((item) => item.id === question.id)!;
    renderUi(<QuestionAttachments item={updated} projectKey="AC" />);
    expect(screen.getByText(t('inbox.attachments.goneLabel', { fileName: 'jelentes.html' }))).toBeTruthy();
    expect(
      screen.queryByRole('link', { name: t('attachments.downloadLabel', { fileName: 'jelentes.html' }) }),
    ).toBeNull();
    // The other files are still there.
    expect(
      screen.getByRole('link', { name: t('attachments.openPdfLabel', { fileName: 'merespecifikacio.pdf' }) }),
    ).toBeTruthy();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/t';
import { AttachmentImageDialog } from './AttachmentImageDialog';

const image = (name: string) => ({ fileName: name, size: 2048, src: `/files/${name}` });

describe('AttachmentImageDialog', () => {
  it('shows the image, and in its place a message when it does not load', async () => {
    render(<AttachmentImageDialog image={image('a.png')} onClose={() => {}} />);
    const img = await screen.findByAltText(t('attachments.previewOf', { fileName: 'a.png' }));
    expect(img.getAttribute('src')).toBe('/files/a.png');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.error(img);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain(t('attachments.imageFailed'));
    expect(status.textContent).toContain(t('attachments.imageFailedHint'));
    expect(screen.queryByRole('img')).toBeNull();
    // The close button and the title stay.
    expect(screen.getByRole('heading', { name: 'a.png' })).toBeTruthy();
  });

  it('starts a new image without the error of the previous one', async () => {
    const { rerender } = render(<AttachmentImageDialog image={image('a.png')} onClose={() => {}} />);
    fireEvent.error(await screen.findByAltText(t('attachments.previewOf', { fileName: 'a.png' })));
    expect(screen.getByRole('status')).toBeTruthy();
    rerender(<AttachmentImageDialog image={image('b.png')} onClose={() => {}} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByAltText(t('attachments.previewOf', { fileName: 'b.png' }))).toBeTruthy();
  });
});

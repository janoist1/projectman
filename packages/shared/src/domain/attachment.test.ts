import { describe, expect, it } from 'vitest';
import {
  attachmentPreviewOf,
  canDeleteAttachment,
  canUploadAttachment,
  coverAttachmentId,
  INLINE_MEDIA_TYPES,
  MAX_ATTACHMENT_BYTES,
  OCTET_STREAM,
  TaskCoverRequest,
} from './attachment';
import type { AttachmentViewer } from './attachment';

const viewerOf = (access: AttachmentViewer['access'], handle = 'someone'): AttachmentViewer => ({
  access,
  handle,
});
const uploadedBy = (kind: 'human' | 'ai', handle: string) => ({ uploadedBy: { kind, handle } });

describe('attachment limits', () => {
  it('is 25 MB, decimal', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(25_000_000);
  });

  it('previews only supported raster images and PDF', () => {
    for (const type of Object.keys(INLINE_MEDIA_TYPES)) expect(attachmentPreviewOf(type)).not.toBe('none');
    for (const type of ['image/svg+xml', 'text/html', OCTET_STREAM, 'image/bmp', ''])
      expect(attachmentPreviewOf(type)).toBe('none');
  });
});

describe('the cover of a card', () => {
  const file = (id: string, preview: 'image' | 'pdf' | 'none') => ({ id, preview });

  it('is the first image in upload order', () => {
    expect(
      coverAttachmentId([file('a', 'pdf'), file('b', 'image'), file('c', 'image'), file('d', 'none')]),
    ).toBe('b');
  });

  it('is the next image once the first is gone', () => {
    expect(coverAttachmentId([file('a', 'pdf'), file('c', 'image')])).toBe('c');
  });

  it('is null without an image', () => {
    expect(coverAttachmentId([])).toBeNull();
    expect(coverAttachmentId([file('a', 'pdf'), file('b', 'none')])).toBeNull();
  });

  describe('with a choice (PM-224)', () => {
    const files = [file('a', 'pdf'), file('b', 'image'), file('c', 'image')];

    it('is the pinned image', () => {
      expect(coverAttachmentId(files, { mode: 'pinned', attachmentId: 'c' })).toBe('c');
    });

    it('is the first image when the pinned one was deleted', () => {
      expect(coverAttachmentId(files, { mode: 'pinned', attachmentId: 'gone' })).toBe('b');
    });

    it('is the first image when the pinned file is not an image', () => {
      expect(coverAttachmentId(files, { mode: 'pinned', attachmentId: 'a' })).toBe('b');
    });

    it('is nothing when hidden, also after new uploads', () => {
      expect(coverAttachmentId(files, { mode: 'hidden' })).toBeNull();
      expect(coverAttachmentId([...files, file('d', 'image')], { mode: 'hidden' })).toBeNull();
    });

    it('is automatic without a choice', () => {
      expect(coverAttachmentId(files, null)).toBe('b');
      expect(coverAttachmentId(files, undefined)).toBe('b');
    });
  });
});

describe('the cover choice', () => {
  it('parses a pinned or a hidden choice and nothing else', () => {
    expect(TaskCoverRequest.parse({ mode: 'hidden' })).toEqual({ mode: 'hidden' });
    expect(TaskCoverRequest.parse({ mode: 'pinned', attachmentId: 'att_abcdefghij' })).toEqual({
      mode: 'pinned',
      attachmentId: 'att_abcdefghij',
    });
    expect(TaskCoverRequest.safeParse({ mode: 'pinned' }).success).toBe(false);
    expect(TaskCoverRequest.safeParse({ mode: 'pinned', attachmentId: '../x' }).success).toBe(false);
    expect(TaskCoverRequest.safeParse({ mode: 'auto' }).success).toBe(false);
    expect(TaskCoverRequest.safeParse({}).success).toBe(false);
  });
});

describe('who may upload and delete attachments', () => {
  it.each([
    ['owner', true],
    ['admin', true],
    ['developer', true],
    ['ai', true],
    ['client', false],
    ['viewer', false],
  ] as const)('%s: upload %s', (access, upload) => {
    expect(canUploadAttachment(viewerOf(access))).toBe(upload);
  });

  it('lets the uploader, a human owner or a human admin delete', () => {
    const own = uploadedBy('human', 'dana');
    expect(canDeleteAttachment(viewerOf('developer', 'dana'), own)).toBe(true);
    expect(canDeleteAttachment(viewerOf('developer', 'eve'), own)).toBe(false);
    expect(canDeleteAttachment(viewerOf('admin', 'eve'), own)).toBe(true);
    expect(canDeleteAttachment(viewerOf('owner', 'eve'), own)).toBe(true);
  });

  it('keeps the uploader a human or an AI member, by kind and handle', () => {
    const byAi = uploadedBy('ai', 'dev');
    expect(canDeleteAttachment(viewerOf('ai', 'dev'), byAi)).toBe(true);
    expect(canDeleteAttachment(viewerOf('ai', 'qa'), byAi)).toBe(false);
    // The same handle as a human does not make the human the uploader.
    expect(canDeleteAttachment(viewerOf('developer', 'dev'), byAi)).toBe(false);
    expect(canDeleteAttachment(viewerOf('ai', 'dev'), uploadedBy('human', 'dev'))).toBe(false);
    expect(
      canDeleteAttachment(viewerOf('ai', 'dev'), {
        uploadedBy: { kind: 'system', handle: null },
      }),
    ).toBe(false);
  });

  it('never lets a viewer delete, not even an older upload of their own', () => {
    expect(canDeleteAttachment(viewerOf('viewer', 'vic'), uploadedBy('human', 'vic'))).toBe(false);
  });

  it('never lets a client delete, not even an older upload of their own (PM-985)', () => {
    expect(canDeleteAttachment(viewerOf('client', 'cleo'), uploadedBy('human', 'cleo'))).toBe(false);
  });
});

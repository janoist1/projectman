import { describe, expect, it } from 'vitest';
import {
  UpdateDocumentRequest,
  canDeleteDocument,
  canEditDocuments,
  canReadDocuments,
  documentOutline,
  documentSection,
  documentSlugOf,
  lacksDocumentMessage,
  parseDocumentRef,
  sectionAnchor,
} from './document';
import type { DocumentViewer } from './document';

const viewer = (access: DocumentViewer['access'], delegated = false): DocumentViewer => ({
  access,
  handle: 'x',
  delegated,
});

describe('document permissions', () => {
  it.each([
    ['owner', true, true, true],
    ['admin', true, true, true],
    ['developer', true, true, false],
    ['ai', true, true, false],
    ['viewer', true, false, false],
    ['client', false, false, false],
  ] as const)('%s: read %s, edit %s, delete %s', (access, read, edit, del) => {
    expect(canReadDocuments(viewer(access))).toBe(read);
    expect(canEditDocuments(viewer(access))).toBe(edit);
    expect(canDeleteDocument(viewer(access))).toBe(del);
  });

  it('refuses a delete that comes through the integrator, even for an owner', () => {
    expect(canDeleteDocument(viewer('owner', true))).toBe(false);
    expect(canEditDocuments(viewer('owner', true))).toBe(true);
  });
});

const SAMPLE = [
  '# Plan',
  'intro',
  '## 1. Árvíz',
  'water',
  '```',
  '# not a heading',
  '```',
  '### Detail',
  'deep',
  '## 2. Next',
  'next text',
  '## 2. Next',
  'again',
].join('\n');

describe('documentOutline', () => {
  it('lists the headings outside code blocks and numbers repeated anchors', () => {
    expect(documentOutline(SAMPLE).map((h) => [h.level, h.anchor])).toEqual([
      [1, 'plan'],
      [2, '1-arviz'],
      [3, 'detail'],
      [2, '2-next'],
      [2, '2-next-2'],
    ]);
  });

  it('does not take a heading from a ~~~ block', () => {
    expect(documentOutline('~~~\n# hidden\n~~~\n# shown')).toHaveLength(1);
  });
});

describe('documentSection', () => {
  it('runs to the next heading of the same or a higher level, subsections included', () => {
    expect(documentSection(SAMPLE, '1-arviz')?.content).toBe(
      ['## 1. Árvíz', 'water', '```', '# not a heading', '```', '### Detail', 'deep'].join('\n'),
    );
  });

  it('finds a section by its heading text and runs the last one to the end', () => {
    expect(documentSection(SAMPLE, '2. Next')?.content).toBe('## 2. Next\nnext text');
    expect(documentSection(SAMPLE, '2-next-2')?.content).toBe('## 2. Next\nagain');
  });

  it('returns null for an unknown section', () => {
    expect(documentSection(SAMPLE, 'nope')).toBeNull();
  });
});

describe('sectionAnchor and parseDocumentRef', () => {
  it('makes an anchor from a heading and falls back to "section"', () => {
    expect(sectionAnchor('  1. Árvíz — tűrő! ')).toBe('1-arviz-turo');
    expect(sectionAnchor('???')).toBe('section');
  });

  it.each([
    ['plan', { slug: 'plan' }],
    ['plan#intro', { slug: 'plan', section: 'intro' }],
    ['plan#', { slug: 'plan' }],
    ['plan#a#b', { slug: 'plan', section: 'a#b' }],
  ])('splits %j', (ref, parsed) => {
    expect(parseDocumentRef(ref)).toEqual(parsed);
  });
});

describe('UpdateDocumentRequest', () => {
  const base = 'a'.repeat(40);
  const message = 'Fix a typo';
  it('needs a title or a content', () => {
    expect(UpdateDocumentRequest.safeParse({ baseVersion: base, message }).success).toBe(false);
    expect(UpdateDocumentRequest.safeParse({ baseVersion: base, content: '', message }).success).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('refuses a %s reason, which lacksDocumentMessage names', (_name, reason) => {
    const parsed = UpdateDocumentRequest.safeParse({ baseVersion: base, content: 'x', message: reason });
    expect(parsed.success).toBe(false);
    expect(!parsed.success && lacksDocumentMessage(parsed.error)).toBe(true);
  });

  it('does not take a reason of more than one line for a missing one', () => {
    const parsed = UpdateDocumentRequest.safeParse({ baseVersion: base, content: 'x', message: 'a\nb' });
    expect(parsed.success).toBe(false);
    expect(!parsed.success && lacksDocumentMessage(parsed.error)).toBe(false);
  });
});

describe('documentSlugOf', () => {
  it.each([
    ['Projektterv', 'projektterv'],
    ['A munka útja: árvíztűrő tükörfúrógép', 'a-munka-utja-arvizturo-tukorfurogep'],
    ['  --Hello,   World!--  ', 'hello-world'],
    ['!!!', 'document'],
    ['', 'document'],
  ])('makes %j into %j', (title, slug) => {
    expect(documentSlugOf(title, new Set())).toBe(slug);
  });

  it('numbers a taken slug, a deleted one included', () => {
    expect(documentSlugOf('Plan', new Set(['plan']))).toBe('plan-2');
    expect(documentSlugOf('Plan', new Set(['plan', 'plan-2']))).toBe('plan-3');
  });

  it('cuts to 64 characters and keeps the suffix inside the limit', () => {
    const long = `${'a'.repeat(63)} b`;
    const slug = documentSlugOf(long, new Set());
    expect(slug).toBe('a'.repeat(63));
    const numbered = documentSlugOf(long, new Set([slug]));
    expect(numbered).toHaveLength(64);
    expect(numbered.endsWith('-2')).toBe(true);
  });
});

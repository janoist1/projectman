import { describe, expect, it } from 'vitest';
import type { DocumentDetail, DocumentSummary } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC/documents';
const get = (backend: MockBackend, path = base, query = new URLSearchParams()) =>
  backend.handle('GET', path, undefined, query);

function seeded() {
  const backend = new MockBackend();
  const slug = backend.documents.seed({ title: 'Projektterv', content: '# Terv', by: 'devops' });
  return { backend, slug };
}

describe('the documents fake', () => {
  it('refuses a client, as the server does', () => {
    const { backend } = seeded();
    backend.viewerHandle = 'kata';
    expect(get(backend).status).toBe(403);
  });

  it('answers a stale base version with a conflict that names the current one', () => {
    const { backend, slug } = seeded();
    const { document } = get(backend, `${base}/${slug}`).body as DocumentDetail;
    backend.documents.changeElsewhere(slug, 'Más szöveg', 'devops');
    const response = backend.handle('PATCH', `${base}/${slug}`, {
      baseVersion: document.version,
      content: 'Az enyém',
      message: 'Javítás',
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'document_conflict' } });
  });

  it('refuses a write without its reason with its own code', () => {
    const { backend, slug } = seeded();
    const { document } = get(backend, `${base}/${slug}`).body as DocumentDetail;
    const response = backend.handle('PATCH', `${base}/${slug}`, {
      baseVersion: document.version,
      content: 'Az enyém',
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: 'document_message_required' } });
  });

  it('deletes only for a login of one’s own, and keeps the history', () => {
    const { backend, slug } = seeded();
    const { document } = get(backend, `${base}/${slug}`).body as DocumentDetail;
    const query = new URLSearchParams({ baseVersion: document.version, message: 'Elavult' });
    backend.integratorMode = 'super';
    expect(backend.handle('DELETE', `${base}/${slug}`, undefined, query).status).toBe(403);
    backend.integratorMode = null;
    expect(backend.handle('DELETE', `${base}/${slug}`, undefined, query).status).toBe(200);
    expect((get(backend).body as { documents: DocumentSummary[] }).documents).toEqual([]);
    expect(get(backend, `${base}/${slug}`).status).toBe(404);
    expect(get(backend, `${base}/${slug}/history`).status).toBe(200);
  });

  it('gives a repeated title a new slug and restores an old version as a new one', () => {
    const { backend, slug } = seeded();
    const first = get(backend, `${base}/${slug}`).body as DocumentDetail;
    const created = backend.handle('POST', base, {
      title: 'Projektterv',
      content: 'második',
      message: 'Új dokumentum',
    });
    expect(created.status).toBe(201);
    expect((created.body as DocumentDetail).document.slug).toBe('projektterv-2');
    backend.documents.changeElsewhere(slug, 'Új szöveg', 'devops');
    const current = get(backend, `${base}/${slug}`).body as DocumentDetail;
    const restored = backend.handle('POST', `${base}/${slug}/restore`, {
      version: first.document.version,
      baseVersion: current.document.version,
      message: 'Vissza',
    });
    expect((restored.body as DocumentDetail).content).toBe('# Terv');
    expect((restored.body as DocumentDetail).document.version).not.toBe(first.document.version);
  });
});

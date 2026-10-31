import { describe, expect, it, vi } from 'vitest';
import type { DocumentViewer } from '@projectman/shared';
import { DocumentStoreError } from '../../config';
import type { DocumentStore, DocumentWriter } from '../../contracts';
import type { DomainContext } from '../base';
import { DocumentService } from './service';

const by: DocumentWriter = {
  name: 'Ann',
  email: 'ann@example.test',
  actor: { kind: 'human', handle: 'ann' },
};
const viewer = (access: DocumentViewer['access'], delegated = false): DocumentViewer => ({
  access,
  handle: 'ann',
  delegated,
});
const VERSION = 'a'.repeat(40);

function setup(overrides: Partial<DocumentStore> = {}) {
  const publish = vi.fn();
  const store = {
    list: vi.fn().mockResolvedValue([]),
    read: vi.fn(),
    create: vi.fn().mockResolvedValue({ slug: 'plan', content: 'x' }),
    update: vi.fn().mockResolvedValue({ slug: 'plan', content: 'x' }),
    remove: vi.fn().mockResolvedValue({ version: VERSION }),
    history: vi.fn().mockResolvedValue([]),
    restore: vi.fn().mockResolvedValue({ slug: 'plan', content: 'x' }),
    ...overrides,
  } as unknown as DocumentStore;
  const service = new DocumentService({ ctx: { bus: { publish } } as unknown as DomainContext, store });
  return { service, store, publish };
}

describe('DocumentService', () => {
  it('tells the clients which document changed, after a write only', async () => {
    const { service, publish } = setup();
    await service.list('AR', viewer('developer'));
    expect(publish).not.toHaveBeenCalled();
    await service.create('AR', viewer('developer'), { title: 'Plan', content: 'x' }, by);
    expect(publish).toHaveBeenCalledWith({ type: 'documents_changed', projectKey: 'AR', slug: 'plan' });
  });

  it('does not touch the store for a member who may not', async () => {
    const { service, store, publish } = setup();
    await expect(service.list('AR', viewer('client'))).rejects.toMatchObject({ status: 403 });
    await expect(
      service.create('AR', viewer('viewer'), { title: 'Plan', content: '' }, by),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(store.list).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ['an AI member', viewer('ai')],
    ['a developer', viewer('developer')],
    ['an owner through the integrator', viewer('owner', true)],
  ])('does not let %s delete', async (_who, who) => {
    const { service, store } = setup();
    await expect(service.remove('AR', 'plan', who, VERSION, by)).rejects.toMatchObject({ status: 403 });
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('lets an owner delete and reports the deleting version', async () => {
    const { service, publish } = setup();
    await expect(service.remove('AR', 'plan', viewer('owner'), VERSION, by)).resolves.toEqual({
      slug: 'plan',
      deleted: true,
      version: VERSION,
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not_found', 404, 'document_not_found'],
    ['conflict', 409, 'document_conflict'],
    ['too_large', 413, 'document_too_large'],
    ['invalid_title', 400, 'invalid_request'],
  ] as const)('maps the store error %s to %s', async (code, status, apiCode) => {
    const { service, publish } = setup({
      update: vi.fn().mockRejectedValue(new DocumentStoreError(code, 'no', { currentVersion: VERSION })),
    });
    await expect(
      service.update('AR', 'plan', viewer('ai'), { content: 'y' }, VERSION, by),
    ).rejects.toMatchObject({
      status,
      code: apiCode,
    });
    expect(publish).not.toHaveBeenCalled();
  });
});

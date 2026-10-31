import { describe, expect, it, vi } from 'vitest';
import type { DocumentSummary, ProjectConfig } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type { ToolContext } from '../../contracts';
import { DomainError } from '../../kernel';
import type { ToolCaller } from '../caller';
import { DocumentTools } from './handler';

const ctx = { projectKey: 'AR', member: 'dev' } as ToolContext;
const VERSION = 'a'.repeat(40);
const summary: DocumentSummary = {
  slug: 'plan',
  title: 'Plan',
  version: VERSION,
  updatedAt: '2026-10-31T10:00:00.000Z',
  updatedBy: { kind: 'ai', name: 'Dev', handle: 'dev' },
};
const CONTENT = '# Plan\n\nIntro\n\n## Risks\n\nSome risks\n\n## Costs\n\nSome costs\n';

function setup(overrides: Record<string, unknown> = {}) {
  const calls = {
    guard: <T>(fn: () => Promise<T>) => fn(),
    caller: vi.fn().mockResolvedValue({ team: { members: [] } } as unknown as ProjectConfig),
  } as unknown as ToolCaller;
  const documents = {
    list: vi.fn().mockResolvedValue([summary]),
    get: vi.fn().mockResolvedValue({ ...summary, content: CONTENT }),
    create: vi.fn().mockResolvedValue({ ...summary, content: CONTENT }),
    update: vi.fn().mockResolvedValue({ ...summary, content: CONTENT }),
    history: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  const tools = new DocumentTools({ calls, documents: documents as never });
  return { tools, calls, documents };
}

describe('DocumentTools', () => {
  it('reads as an AI member, after the caller check of the tool', async () => {
    const { tools, calls, documents } = setup();
    await tools.listDocuments(ctx);
    expect(calls.caller).toHaveBeenCalledWith(ctx, 'list_documents');
    expect(documents.list).toHaveBeenCalledWith('AR', { access: 'ai', handle: 'dev' });
  });

  it('refuses before the service when the caller check refuses (a guest conversation)', async () => {
    const { tools, documents } = setup();
    const refusing = new DocumentTools({
      calls: {
        guard: <T>(fn: () => Promise<T>) => fn(),
        caller: vi.fn().mockRejectedValue(new TeamToolError('forbidden', 'no')),
      } as unknown as ToolCaller,
      documents: documents as never,
    });
    await expect(refusing.listDocuments(ctx)).rejects.toMatchObject({ code: 'forbidden' });
    expect(documents.list).not.toHaveBeenCalled();
    await tools.listDocuments(ctx);
    expect(documents.list).toHaveBeenCalledTimes(1);
  });

  it('reads only the section of a "slug#section" reference, with its subsections', async () => {
    const { tools, documents } = setup();
    const read = await tools.readDocument(ctx, { ref: 'plan#risks' });
    expect(documents.get).toHaveBeenCalledWith('AR', 'plan', { access: 'ai', handle: 'dev' }, undefined);
    expect(read.section?.anchor).toBe('risks');
    expect(read.content).toContain('Some risks');
    expect(read.content).not.toContain('Some costs');
  });

  it('lists the headings when the section is unknown', async () => {
    const { tools } = setup();
    const err = await tools.readDocument(ctx, { ref: 'plan#nope' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamToolError);
    expect((err as Error).message).toContain('risks');
    expect((err as Error).message).toContain('costs');
  });

  it('reads an old version of the whole document', async () => {
    const { tools, documents } = setup();
    const read = await tools.readDocument(ctx, { ref: 'plan', version: 'b'.repeat(40) });
    expect(documents.get).toHaveBeenCalledWith('AR', 'plan', expect.anything(), 'b'.repeat(40));
    expect(read.section).toBeUndefined();
    expect(read.content).toBe(CONTENT);
  });

  it('creates with a title and content, authored by the member', async () => {
    const { tools, documents } = setup();
    const result = await tools.writeDocument(ctx, {
      title: 'Plan',
      content: CONTENT,
      message: 'First draft',
    });
    expect(result.created).toBe(true);
    expect(documents.create).toHaveBeenCalledWith(
      'AR',
      expect.anything(),
      { title: 'Plan', content: CONTENT, message: 'First draft' },
      expect.objectContaining({ actor: { kind: 'ai', handle: 'dev' } }),
    );
  });

  it.each([
    ['a new document without content', { title: 'Plan' }],
    ['an edit without the base version', { slug: 'plan', content: 'x' }],
    ['an edit that changes nothing', { slug: 'plan', baseVersion: VERSION }],
  ])('refuses %s', async (_name, args) => {
    const { tools, documents } = setup();
    await expect(tools.writeDocument(ctx, { ...args, message: 'Why' })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(documents.create).not.toHaveBeenCalled();
    expect(documents.update).not.toHaveBeenCalled();
  });

  it('tells the agent the current version when the base version is stale', async () => {
    const current = 'c'.repeat(40);
    const { tools } = setup({
      update: vi.fn().mockRejectedValue(
        new DomainError('document_conflict', 'The document changed', {
          status: 409,
          details: { currentVersion: current },
        }),
      ),
    });
    const err = await tools
      .writeDocument(ctx, { slug: 'plan', content: 'x', baseVersion: VERSION, message: 'Fix' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamToolError);
    expect((err as Error).message).toContain(current);
  });

  it('maps a permission refusal to a forbidden tool error', async () => {
    const { tools } = setup({
      list: vi.fn().mockRejectedValue(new DomainError('insufficient_access', 'No', { status: 403 })),
    });
    await expect(tools.listDocuments(ctx)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

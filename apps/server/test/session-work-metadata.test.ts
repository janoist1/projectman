import { afterEach, describe, expect, it } from 'vitest';

import { createDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/** PM-694: what a session's chat proves about its work, kept without text. */
let h: DomainHarness;
let now: Date;
afterEach(async () => {
  await h?.cleanup();
});

const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();

describe('session work metadata', () => {
  async function start() {
    now = new Date('2026-10-14T10:00:00Z');
    h = await createDomainHarness({ now: () => now });
    await h.domain.tasks.create('AR', { title: 'Card', repo: 'web' }, { kind: 'human', handle: 'owner' });
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', {
      type: 'task',
      taskKey: 'AR-1',
    });
    return session;
  }
  const chat = (sessionId: string, ...items: Array<Record<string, unknown>>) =>
    h.runner.emit({ type: 'chat', sessionId, items } as never);
  const metadata = (sessionId: string) => h.domain.sessions.get('AR', sessionId).workMetadata;

  it('starts without metadata', async () => {
    const session = await start();
    expect(metadata(session.id)).toBeUndefined();
  });

  it('keeps the last step, tool and failure from the chat, with no text', async () => {
    const session = await start();
    chat(
      session.id,
      {
        id: 'c1',
        ts: at(-30),
        kind: 'tool_call',
        toolUseId: 't1',
        name: 'update_task',
        summary: 'confidential summary',
        input: { note: 'confidential input' },
      },
      {
        id: 'r1',
        ts: at(-29),
        kind: 'tool_result',
        toolUseId: 't1',
        ok: false,
        summary: 'confidential failure',
      },
    );
    expect(metadata(session.id)).toEqual({
      lastWorkAt: at(-30),
      lastTool: { name: 'update_task', at: at(-30) },
      lastError: { code: 'tool_failed', at: at(-29) },
    });
    const stored = h.repos.sessions.get(session.id)!;
    expect(JSON.stringify(stored)).not.toContain('confidential');
  });

  it('counts incoming messages and idle assistant text as no step', async () => {
    const session = await start();
    h.runner.setState(session.id, 'idle');
    chat(
      session.id,
      {
        id: 'm1',
        ts: at(-20),
        kind: 'team_message',
        direction: 'in',
        from: 'owner',
        to: ['dev-1'],
        text: 'Hi',
      },
      { id: 'a1', ts: at(-10), kind: 'assistant_text', text: 'Noted' },
    );
    expect(metadata(session.id)).toBeUndefined();
    h.runner.setState(session.id, 'working');
    chat(session.id, { id: 'a2', ts: at(-5), kind: 'assistant_text', text: 'Working' });
    expect(metadata(session.id)).toMatchObject({ lastWorkAt: at(-5), lastTool: null });
  });

  it('does not write forward when the same or earlier items come again', async () => {
    const session = await start();
    const call = (id: string, seconds: number) => ({
      id,
      ts: at(seconds),
      kind: 'tool_call',
      toolUseId: id,
      name: 'get_task',
      summary: '',
      input: {},
    });
    chat(session.id, call('c1', -10));
    const first = metadata(session.id);
    chat(session.id, call('c1', -10), call('c0', -50));
    expect(metadata(session.id)).toEqual(first);
    chat(session.id, call('c2', -2));
    expect(metadata(session.id)).toMatchObject({ lastWorkAt: at(-2) });
  });
});

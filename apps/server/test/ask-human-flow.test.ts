import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InboxView, questionPayloadOf, routes } from '@projectman/shared';
import type { InboxItem, Task } from '@projectman/shared';
import { createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';

/**
 * A plain-language question on its whole way: the asking member's ask_human call reaches the
 * real MCP endpoint, the domain stores the question in SQLite, the inbox API serves it, and the
 * owner's answer goes back to the asking session.
 */
describe('ask_human through the MCP endpoint and the inbox API', () => {
  let h: AppHarness;
  let cookie: string;
  let token: string;
  let sessionId: string;

  beforeEach(async () => {
    h = await createAppHarness({ real: { mcp: true } });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const task = (
      await inject(h.app, 'POST', routes.tasks('AR'), cookie, { title: 'Validate the login form' })
    ).json<Task>();
    const started = await inject(h.app, 'POST', routes.startTask('AR', task.key), cookie, {});
    expect(started.statusCode, started.body).toBe(200);
    const spec = h.runner.lastStarted();
    token = spec.mcpUrl.split('/').pop()!;
    sessionId = spec.sessionId;
  });
  afterEach(() => h.close());

  /** One tools/call on the asking member's own MCP endpoint (stateless: no handshake needed). */
  async function askHuman(args: Record<string, unknown>) {
    const response = await h.app.inject({
      method: 'POST',
      url: `/mcp/${token}`,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ask_human', arguments: args },
      }),
    });
    expect(response.statusCode, response.body).toBe(200);
    const { result } = response.json<{ result: { isError?: boolean; content: Array<{ text: string }> } }>();
    return { isError: result.isError === true, text: result.content.map((c) => c.text).join('\n') };
  }

  async function openQuestions(): Promise<InboxItem[]> {
    const response = await inject(h.app, 'GET', routes.inbox('AR'), cookie);
    return InboxView.parse(response.json()).items.filter((item) => item.kind === 'question');
  }

  it('serves the question with its consequences, recommendation and details, and returns the answer', async () => {
    const question = 'Should a wrong email show its error under the field or as a pop-up?';
    const details = '`EmailField` already renders `aria-live` errors.\n\nA toast needs a new provider.';

    const asked = await askHuman({
      question,
      options: [
        { label: 'Under the field', consequence: 'The message stays until the address is fixed.' },
        { label: 'Pop-up', consequence: 'It disappears after a few seconds, so it can be missed.' },
      ],
      recommended: 'Under the field',
      recommendation_reason: 'It is easier to read on a phone.',
      details,
    });

    expect(asked.isError).toBe(false);
    expect(asked.text).toMatch(/^Question inb_\w+ is waiting in the inbox\.$/);
    const [item] = await openQuestions();
    expect(item).toMatchObject({
      title: question,
      source: 'dev-1',
      sessionId,
      taskKey: 'AR-1',
      state: 'open',
    });
    expect(item!.options).toEqual([
      {
        id: 'option_1',
        label: 'Under the field',
        style: 'primary',
        consequence: 'The message stays until the address is fixed.',
      },
      {
        id: 'option_2',
        label: 'Pop-up',
        style: 'secondary',
        consequence: 'It disappears after a few seconds, so it can be missed.',
      },
      { id: 'answer', label: 'answer', style: 'secondary' },
    ]);
    expect(questionPayloadOf(item!)).toEqual({
      question,
      options: ['Under the field', 'Pop-up'],
      recommended: 'option_1',
      recommendationReason: 'It is easier to read on a phone.',
      details,
    });

    const resolved = await inject(h.app, 'POST', routes.resolveInbox('AR', item!.id), cookie, {
      optionId: 'option_1',
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    await flush();
    const delivered = h.runner.messages.filter((m) => m.sessionId === sessionId).pop()!;
    expect(delivered.text).toBe(
      `[team message from owner about AR-1]\nAnswer to your question "${question}":\n\nUnder the field`,
    );
  });

  it('refuses a recommendation that is not an option, and stores nothing', async () => {
    const refused = await askHuman({
      question: 'Inline or toast?',
      options: ['Inline', 'Toast'],
      recommended: 'Dialog',
    });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('recommended must be exactly one of the options: "Inline", "Toast".');
    expect(await openQuestions()).toEqual([]);
  });

  it('still asks a long question without a recommendation, with a hint on how to write the next one', async () => {
    const question =
      `Should we change how the login page talks to the server? ${'It is complicated. '.repeat(20)}`.trim();

    const asked = await askHuman({ question, options: ['Yes', 'No'] });

    expect(asked.isError).toBe(false);
    expect(asked.text).toContain('Consider moving detail into details.');
    expect(asked.text).toContain('Consider adding a recommendation with a one-sentence reason');
    const [item] = await openQuestions();
    expect(item!.title).toBe(question);
    // An old-style question: no recommendation, no details, no consequences.
    expect(questionPayloadOf(item!)).toEqual({ question, options: ['Yes', 'No'] });
    expect(item!.options.map((o) => o.consequence)).toEqual([undefined, undefined, undefined]);
  });
});

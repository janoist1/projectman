import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatItem, InboxItem } from '@projectman/shared';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { Markdown } from '../../components/Markdown';
import { groupChatItems } from '../../lib/chat';
import { inbox } from '../../mocks/fixtures';
import { mockIndexes } from '../../test/render';
import { ChatView } from './ChatView';

const at = (minute: number) => `2026-09-29T14:${String(minute).padStart(2, '0')}:00.000Z`;

const items: ChatItem[] = [
  { id: 'u1', ts: at(1), kind: 'user_text', origin: 'human', text: 'Kérlek, javítsd a gombsort.' },
  { id: 'a1', ts: at(2), kind: 'assistant_text', text: 'Megnézem, aztán **javítom**.' },
  {
    id: 'c1',
    ts: at(3),
    kind: 'tool_call',
    toolUseId: 't1',
    name: 'Read',
    summary: 'src/app.css',
    input: {},
  },
  { id: 'r1', ts: at(3), kind: 'tool_result', toolUseId: 't1', ok: true, summary: '42 sor' },
  { id: 'c2', ts: at(4), kind: 'tool_call', toolUseId: 't2', name: 'Bash', summary: 'npm test', input: {} },
  { id: 'r2', ts: at(4), kind: 'tool_result', toolUseId: 't2', ok: false, summary: 'exit 1' },
  {
    id: 'c3',
    ts: at(5),
    kind: 'tool_call',
    toolUseId: 't3',
    name: 'Bash',
    summary: 'git push origin main',
    input: {},
  },
  {
    id: 'm1',
    ts: at(6),
    kind: 'team_message',
    direction: 'in',
    from: 'qa',
    to: ['fe-1'],
    text: 'Hiba: kilóg a gombsor.',
  },
  {
    id: 'm2',
    ts: at(7),
    kind: 'team_message',
    direction: 'out',
    from: 'fe-1',
    to: ['code-review'],
    text: 'Kész, nézd át.',
  },
  { id: 'n1', ts: at(8), kind: 'system_note', text: 'A session folytatódott.' },
];

describe('groupChatItems', () => {
  it('collapses consecutive tool calls into one block and pairs results with calls', () => {
    const blocks = groupChatItems(items, 'fe-1');
    expect(blocks.map((block) => block.type)).toEqual(['user', 'assistant', 'tools', 'team', 'team', 'note']);
    const tools = blocks[2];
    expect(
      tools?.type === 'tools' && tools.rows.map((row) => [row.call?.toolUseId, row.result?.ok ?? null]),
    ).toEqual([
      ['t1', true],
      ['t2', false],
      ['t3', null],
    ]);
  });

  it('pairs a late result with its call even when other items came between', () => {
    const late: ChatItem[] = [
      { id: 'c1', ts: at(1), kind: 'tool_call', toolUseId: 't1', name: 'Bash', summary: 'make', input: {} },
      { id: 'n1', ts: at(2), kind: 'system_note', text: 'közben' },
      { id: 'r1', ts: at(3), kind: 'tool_result', toolUseId: 't1', ok: true, summary: 'kész' },
    ];
    const blocks = groupChatItems(late, null);
    expect(blocks).toHaveLength(2);
    const tools = blocks[0];
    expect(tools?.type === 'tools' && tools.rows[0]?.result?.summary).toBe('kész');
  });

  it('turns an injected team message prefix into a team message', () => {
    const blocks = groupChatItems(
      [
        {
          id: 'u1',
          ts: at(1),
          kind: 'user_text',
          origin: 'human',
          text: '[team message from qa about AC-21]\nÚjrateszt kész.',
        },
      ],
      'fe-1',
    );
    expect(blocks[0]).toMatchObject({
      type: 'team',
      item: { direction: 'in', from: 'qa', text: 'Újrateszt kész.' },
    });
  });
});

describe('ChatView', () => {
  const { members, pipeline } = mockIndexes();

  it('renders a brief as a collapsed task description card while human messages stay in chat', () => {
    const brief: ChatItem = {
      id: 'brief',
      ts: at(0),
      kind: 'user_text',
      origin: 'brief',
      text: 'Fictional task brief',
    };
    render(<ChatView items={[brief, ...items]} sessionMember="fe-1" members={members} myHandle="owner" />);
    const card = screen.getByText(t('session.chat.brief')).closest('details')!;
    expect(card.open).toBe(false);
    expect(within(card).getByText('Fictional task brief')).toBeTruthy();
    expect(screen.getByText('Kérlek, javítsd a gombsort.').closest('details')).toBeNull();
  });

  it('renders every chat item kind', () => {
    render(
      <ChatView items={items} sessionMember="fe-1" members={members} myHandle="owner" pipeline={pipeline} />,
    );
    expect(screen.getByText('Kérlek, javítsd a gombsort.')).toBeTruthy();
    expect(screen.getByText('javítom').tagName).toBe('STRONG');
    expect(screen.getAllByText('Frontend fejlesztő').length).toBeGreaterThan(0);
    // The three calls are one closed line; the rows are behind it.
    const fold = screen.getByText(/3 lépés/).closest('details')!;
    expect(fold.open).toBe(false);
    fireEvent.click(within(fold).getByText(/3 lépés/));
    const tools = screen.getByRole('list', { name: t('session.chat.toolGroup') });
    const rows = within(tools).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText(t('session.tools.Read'))).toBeTruthy();
    expect(within(rows[0]!).getByText('42 sor')).toBeTruthy();
    expect(within(rows[1]!).getByText('hiba · exit 1')).toBeTruthy();
    expect(within(rows[2]!).getByText(t('session.tools.git'))).toBeTruthy();
    expect(within(rows[2]!).getByText(t('session.chat.toolRunning'))).toBeTruthy();
    expect(screen.getByText('Hiba: kilóg a gombsor.')).toBeTruthy();
    expect(screen.getByText('QA')).toBeTruthy();
    expect(screen.getByText(t('session.chat.teamMessageOut'))).toBeTruthy();
    expect(screen.getByText('Code review')).toBeTruthy();
    expect(screen.getByText('A session folytatódott.')).toBeTruthy();
  });

  it('folds a run of tool calls into one summary line and writes the results in Hungarian', () => {
    const call = (n: number, name: string, summary: string): ChatItem => ({
      id: `c${n}`,
      ts: at(10),
      kind: 'tool_call',
      toolUseId: `t${n}`,
      name,
      summary,
      input: {},
    });
    const result = (n: number, text: string, ok = true): ChatItem => ({
      id: `r${n}`,
      ts: at(10),
      kind: 'tool_result',
      toolUseId: `t${n}`,
      ok,
      summary: text,
    });
    const run: ChatItem[] = [
      call(1, 'Read', 'a.ts'),
      result(1, '397 lines'),
      call(2, 'Read', 'a.ts'),
      result(2, 'Read'),
      call(3, 'Read', 'b.ts'),
      result(3, '12 lines'),
      call(4, 'Edit', 'b.ts'),
      result(4, 'Edited'),
      call(5, 'Write', 'c.ts'),
      result(5, 'Created'),
      call(6, 'Bash', 'npm test'),
      result(6, 'Done'),
      call(7, 'Bash', 'npm run build'),
      result(7, 'Failed', false),
      call(8, 'Grep', 'foo'),
      result(8, '3 files'),
    ];
    render(<ChatView items={run} sessionMember="fe-1" members={members} myHandle="owner" />);
    const summary = screen.getByText(/8 lépés/).closest('summary')!;
    // Files are counted once however often they were read; failures are named on the closed line.
    expect(summary.textContent).toBe(
      '8 lépés · 2 fájl olvasva, 1 keresés, 2 fájl szerkesztve, 2 parancs, 1 hiba',
    );
    expect(summary.closest('details')!.open).toBe(false);

    fireEvent.click(summary);
    const rows = within(screen.getByRole('list', { name: t('session.chat.toolGroup') })).getAllByRole(
      'listitem',
    );
    const texts = rows.map((row) => row.textContent ?? '');
    expect(texts[0]).toContain('397 sor');
    expect(texts[1]).toContain('beolvasva');
    expect(texts[3]).toContain('módosítva');
    expect(texts[4]).toContain('létrehozva');
    expect(texts[5]).toContain('kész');
    expect(texts[6]).toMatch(/hiba$/);
    expect(texts[7]).toContain('3 fájl');
    for (const text of texts) expect(text).not.toMatch(/Edited|Created|lines|files|Failed|Done/);
  });

  it('keeps the tool result text of an unknown tool as it came', () => {
    const run: ChatItem[] = [
      { id: 'c1', ts: at(1), kind: 'tool_call', toolUseId: 't1', name: 'Bash', summary: 'ls', input: {} },
      { id: 'r1', ts: at(1), kind: 'tool_result', toolUseId: 't1', ok: true, summary: 'package.json' },
    ];
    render(<ChatView items={run} sessionMember="fe-1" members={members} myHandle="owner" />);
    expect(screen.getByText('package.json')).toBeTruthy();
  });

  it('shows the latest running step on the closed line', () => {
    const run: ChatItem[] = [
      { id: 'c1', ts: at(1), kind: 'tool_call', toolUseId: 't1', name: 'Read', summary: 'a.ts', input: {} },
      { id: 'r1', ts: at(1), kind: 'tool_result', toolUseId: 't1', ok: true, summary: '3 lines' },
      {
        id: 'c2',
        ts: at(2),
        kind: 'tool_call',
        toolUseId: 't2',
        name: 'Bash',
        summary: 'npm test',
        input: {},
      },
    ];
    render(<ChatView items={run} sessionMember="fe-1" members={members} myHandle="owner" />);
    const summary = screen.getByText(/2 lépés/).closest('summary')!;
    expect(summary.textContent).toContain(t('session.chat.toolRunning'));
    expect(summary.textContent).toContain('npm test');
  });

  it('counts a Codex patch as an edit and writes its exit code in Hungarian', () => {
    const run: ChatItem[] = [
      {
        id: 'c1',
        ts: at(1),
        kind: 'tool_call',
        toolUseId: 't1',
        name: 'apply_patch',
        summary: 'src/a.ts',
        input: {},
      },
      { id: 'r1', ts: at(1), kind: 'tool_result', toolUseId: 't1', ok: true, summary: 'Done' },
      { id: 'c2', ts: at(2), kind: 'tool_call', toolUseId: 't2', name: 'Bash', summary: 'make', input: {} },
      { id: 'r2', ts: at(2), kind: 'tool_result', toolUseId: 't2', ok: false, summary: 'Exit code 2' },
    ];
    render(<ChatView items={run} sessionMember="fe-1" members={members} myHandle="owner" />);
    const summary = screen.getByText(/2 lépés/).closest('summary')!;
    expect(summary.textContent).toBe('2 lépés · 1 fájl szerkesztve, 1 parancs, 1 hiba');
    fireEvent.click(summary);
    const rows = within(screen.getByRole('list', { name: t('session.chat.toolGroup') })).getAllByRole(
      'listitem',
    );
    expect(rows[0]!.textContent).toContain(t('session.tools.apply_patch'));
    expect(rows[0]!.textContent).not.toContain('apply_patch');
    expect(rows[0]!.textContent).toContain('kész');
    expect(rows[1]!.textContent).toContain('hiba · kilépési kód: 2');
    expect(rows[1]!.textContent).not.toContain('Exit code');
  });

  it('is its own summary for a single step: kind, argument and outcome', () => {
    const run: ChatItem[] = [
      {
        id: 'c1',
        ts: at(1),
        kind: 'tool_call',
        toolUseId: 't1',
        name: 'Bash',
        summary: 'git push origin main',
        input: {},
      },
      { id: 'r1', ts: at(1), kind: 'tool_result', toolUseId: 't1', ok: false, summary: 'Failed' },
    ];
    render(<ChatView items={run} sessionMember="fe-1" members={members} myHandle="owner" />);
    const summary = screen.getAllByText('git push origin main')[0]!.closest('summary')!;
    expect(summary.textContent).toBe('Git:git push origin main· hiba');
    expect(summary.textContent).not.toContain('1 lépés');
  });

  it('shows the latest running step on its own line under a long summary', () => {
    const run: ChatItem[] = [
      { id: 'c1', ts: at(1), kind: 'tool_call', toolUseId: 't1', name: 'Read', summary: 'a.ts', input: {} },
      { id: 'r1', ts: at(1), kind: 'tool_result', toolUseId: 't1', ok: true, summary: '3 lines' },
      {
        id: 'c2',
        ts: at(2),
        kind: 'tool_call',
        toolUseId: 't2',
        name: 'Bash',
        summary: 'npm test',
        input: {},
      },
    ];
    render(<ChatView items={run} sessionMember="fe-1" members={members} myHandle="owner" />);
    const summary = screen.getByText(/2 lépés/).closest('summary')!;
    const peek = within(summary).getByText('npm test').closest('span[class*="peek"]')!;
    expect(peek.textContent).toBe(`${t('session.tools.Bash')}:npm test· ${t('session.chat.toolRunning')}`);
    // The summary text itself is not in the peek.
    expect(peek.textContent).not.toContain('lépés');
  });

  it('does not call an unanswered tool of a stopped session running', () => {
    const run: ChatItem[] = [
      { id: 'c1', ts: at(1), kind: 'tool_call', toolUseId: 't1', name: 'Read', summary: 'a.ts', input: {} },
      { id: 'r1', ts: at(1), kind: 'tool_result', toolUseId: 't1', ok: true, summary: '3 lines' },
      {
        id: 'c2',
        ts: at(2),
        kind: 'tool_call',
        toolUseId: 't2',
        name: 'Bash',
        summary: 'npm test',
        input: {},
      },
    ];
    render(<ChatView items={run} sessionMember="fe-1" members={members} myHandle="owner" live={false} />);
    const summary = screen.getByText(/2 lépés/).closest('summary')!;
    expect(summary.textContent).not.toContain(t('session.chat.toolRunning'));
    fireEvent.click(summary);
    expect(screen.queryByText(t('session.chat.toolRunning'))).toBeNull();
    expect(screen.getByText(t('session.chat.toolStopped'))).toBeTruthy();
  });

  it('shows the open permission request inline and resolves it', () => {
    const request = inbox.find((item) => item.id === 'inb_perm_push') as InboxItem;
    const onResolve = vi.fn();
    render(
      <ChatView
        items={items}
        sessionMember="fe-1"
        members={members}
        myHandle="owner"
        openItems={[request]}
        onResolve={onResolve}
        awaitingPermission
      />,
    );
    const prompt = screen.getByRole('region', { name: t('session.chat.permissionTitle') });
    expect(within(prompt).getByText('git push origin 21-order-confirmation')).toBeTruthy();
    // The closed tool line says what the session waits for, without opening it.
    const closed = screen.getByText(/3 lépés/).closest('summary')!;
    expect(within(closed).getByText(new RegExp(t('session.chat.toolAwaiting')))).toBeTruthy();
    expect(closed.textContent).toContain('git push origin main');
    fireEvent.click(within(prompt).getByRole('button', { name: t('inbox.options.allow_session') }));
    expect(onResolve).toHaveBeenCalledWith(request, { optionId: 'allow_session' });
    fireEvent.click(within(prompt).getByRole('button', { name: t('inbox.options.deny') }));
    expect(onResolve).toHaveBeenLastCalledWith(request, { optionId: 'deny' });
    // The same row as in the inbox: refusal and permission together, the rarer option apart.
    const deny = within(prompt).getByRole('button', { name: t('inbox.options.deny') });
    const allow = within(prompt).getByRole('button', { name: t('inbox.options.allow') });
    const always = within(prompt).getByRole('button', { name: t('inbox.options.allow_session') });
    expect(deny.parentElement).toBe(allow.parentElement);
    expect(always.parentElement).not.toBe(allow.parentElement);
  });

  it('shows decisions on earlier permission requests in the stream', () => {
    const resolved: InboxItem = {
      ...(inbox.find((item) => item.id === 'inb_perm_push') as InboxItem),
      state: 'resolved',
      resolution: { optionId: 'allow', by: 'owner', at: at(9), note: null },
    };
    render(
      <ChatView
        items={items}
        sessionMember="fe-1"
        members={members}
        myHandle="owner"
        resolvedItems={[resolved]}
      />,
    );
    expect(screen.getByText(/Engedélyezve: git push · Te/)).toBeTruthy();
  });

  it.each(['allow', 'deny'] as const)('attributes automatic %s decisions to the system', (optionId) => {
    const resolved: InboxItem = {
      ...(inbox.find((item) => item.id === 'inb_perm_push') as InboxItem),
      state: 'resolved',
      resolution: { optionId, by: 'system', at: at(9), note: null },
    };
    render(
      <ChatView
        items={items}
        sessionMember="fe-1"
        members={members}
        myHandle="owner"
        resolvedItems={[resolved]}
      />,
    );
    const label = t(`inbox.resolutions.automatic_${optionId}`);
    const line = screen.getByText((text) => text.startsWith(label));
    expect(line.textContent).toContain(t('common.system'));
  });

  it('shows an empty state and pending messages', () => {
    const { rerender } = render(
      <ChatView items={[]} sessionMember="fe-1" members={members} myHandle="owner" />,
    );
    expect(screen.getByText(t('session.chat.empty'))).toBeTruthy();
    rerender(
      <ChatView
        items={[]}
        sessionMember="fe-1"
        members={members}
        myHandle="owner"
        pending={[{ id: 'p1', text: 'Mehet a push?', failed: false }]}
      />,
    );
    expect(screen.getByText('Mehet a push?')).toBeTruthy();
    expect(screen.getByText(t('session.composer.pending'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('session.composer.retry') })).toBeNull();
  });

  it('offers to send a message that did not go out again', () => {
    const onRetry = vi.fn();
    render(
      <ChatView
        items={[]}
        sessionMember="fe-1"
        members={members}
        myHandle="owner"
        pending={[{ id: 'p1', text: 'Mehet a push?', failed: true }]}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(t('session.composer.failed'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('session.composer.retry') }));
    expect(onRetry).toHaveBeenCalledWith('p1');
  });
});

it('renders hostile transcript markdown as text and opens safe links without an opener', () => {
  const { container } = render(
    <Markdown
      text={
        '<script>alert(1)</script> <img src=x onerror=alert(1)> [bad](javascript:alert(1)) [safe](https://example.com)'
      }
    />,
  );
  expect(container.querySelector('script, img')).toBeNull();
  const links = container.querySelectorAll('a');
  expect(links).toHaveLength(1);
  expect(links[0]!.getAttribute('href')).toBe('https://example.com');
  expect(links[0]!.getAttribute('rel')).toBe('noreferrer noopener');
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatItem, InboxItem } from '@projectman/shared';
import { describe, expect, it, vi } from 'vitest';
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
    const card = screen.getByText('Feladatleírás').closest('details')!;
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
    const tools = screen.getByRole('list', { name: 'Eszközhívások' });
    const rows = within(tools).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Olvasás')).toBeTruthy();
    expect(within(rows[0]!).getByText('42 sor')).toBeTruthy();
    expect(within(rows[1]!).getByText('hiba · exit 1')).toBeTruthy();
    expect(within(rows[2]!).getByText('Git')).toBeTruthy();
    expect(within(rows[2]!).getByText('fut…')).toBeTruthy();
    expect(screen.getByText('Hiba: kilóg a gombsor.')).toBeTruthy();
    expect(screen.getByText('QA')).toBeTruthy();
    expect(screen.getByText('Csapatüzenet')).toBeTruthy();
    expect(screen.getByText('Code review')).toBeTruthy();
    expect(screen.getByText('A session folytatódott.')).toBeTruthy();
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
    const prompt = screen.getByRole('region', { name: 'Engedélyt kér' });
    expect(within(prompt).getByText('git push origin 21-order-confirmation')).toBeTruthy();
    expect(screen.getByText('engedélyre vár')).toBeTruthy();
    fireEvent.click(within(prompt).getByRole('button', { name: 'Mindig, ebben a sessionben' }));
    expect(onResolve).toHaveBeenCalledWith(request, { optionId: 'allow_session' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Elutasítom' }));
    expect(onResolve).toHaveBeenLastCalledWith(request, { optionId: 'deny' });
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

  it('shows an empty state and pending messages', () => {
    const { rerender } = render(
      <ChatView items={[]} sessionMember="fe-1" members={members} myHandle="owner" />,
    );
    expect(screen.getByText('Még nincs üzenet ebben a sessionben.')).toBeTruthy();
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
    expect(screen.getByText('Elküldve, sorban áll')).toBeTruthy();
  });
});

import { TEAM_MESSAGE_PREFIX_RE, formatInjectedTeamMessage } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import {
  ToolNames,
  UNKNOWN_MEMBER,
  UserTurns,
  recipients,
  selfHandle,
  sentTeamMessage,
  textOf,
  undeliveredTeamMessage,
} from './chat-items';
import { num, rec, str } from './json';

const ts = '2026-10-01T10:00:00.000Z';
it('keeps sender, integrator and card key separate in both prefix forms', () => {
  for (const via of [undefined, 'integrator'] as const) {
    const text = formatInjectedTeamMessage('owner', 'Review this.', 'AR-1', via);
    const match = TEAM_MESSAGE_PREFIX_RE.exec(text)!;
    expect(match[1]).toBe('owner');
    expect(match[3]).toBe('AR-1');
    expect(Boolean(match.groups?.via)).toBe(Boolean(via));
    const item = new UserTurns('dev-1', 'human').item(text, 'u1', ts);
    expect(item).toMatchObject({ kind: 'team_message', from: 'owner', text: 'Review this.' });
    expect('via' in item ? item.via : undefined).toBe(via);
  }
});

describe('JSON helpers', () => {
  it('accept only the expected shapes', () => {
    expect(rec({ a: 1 })).toEqual({ a: 1 });
    expect(rec([1])).toBeNull();
    expect(rec(null)).toBeNull();
    expect(str('x')).toBe('x');
    expect(str(1)).toBeNull();
    expect(num(2.5)).toBe(2.5);
    expect(num(Number.NaN)).toBeNull();
    expect(num('3')).toBeNull();
  });
});

describe('textOf', () => {
  it('joins the texts of a list, optionally only of accepted items', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'input_text', text: 'second' },
      { type: 'image' },
      'not an item',
    ];
    expect(textOf('plain')).toBe('plain');
    expect(textOf(content)).toBe('first\n\nsecond');
    expect(textOf(content, (item) => item.type === 'text')).toBe('first');
    expect(textOf({ text: 'object' })).toBe('');
  });
});

describe('recipients and selfHandle', () => {
  it('keep valid member handles only', () => {
    expect(recipients(['qa', 'Not A Handle', 7])).toEqual(['qa']);
    expect(recipients('fe-1')).toEqual(['fe-1']);
    expect(recipients(undefined)).toEqual([]);
    expect(selfHandle('fe-1')).toBe('fe-1');
    expect(selfHandle('Anna')).toBeNull();
    expect(selfHandle(undefined)).toBeNull();
  });
});

describe('UserTurns', () => {
  it('reads only the first turn as the brief, and team messages as incoming', () => {
    const turns = new UserTurns('fe-1');
    expect(turns.item('Build the login page', 'u1', ts)).toEqual({
      kind: 'user_text',
      id: 'u1',
      ts,
      text: 'Build the login page',
      origin: 'brief',
    });
    expect(turns.item(formatInjectedTeamMessage('qa', 'Tests pass', 'AR-1'), 'u2', ts)).toEqual({
      kind: 'team_message',
      id: 'u2',
      ts,
      direction: 'in',
      from: 'qa',
      to: ['fe-1'],
      text: 'Tests pass',
    });
    expect(turns.item('Thanks', 'u3', ts)).toMatchObject({ kind: 'user_text', origin: 'human' });
  });

  it('starts with a human turn for general chats and leaves the recipient empty without a member', () => {
    const turns = new UserTurns(null, 'human');
    expect(turns.item('Hello', 'u1', ts)).toMatchObject({ kind: 'user_text', origin: 'human' });
    expect(turns.item(formatInjectedTeamMessage('qa', 'Hi'), 'u2', ts)).toMatchObject({
      kind: 'team_message',
      to: [],
    });
  });
});

describe('team message items', () => {
  it('builds sent and undelivered team messages', () => {
    expect(sentTeamMessage({ to: ['qa', 'nope!'], text: 'Ready' }, 'a1', ts, 'fe-1')).toEqual({
      kind: 'team_message',
      id: 'a1',
      ts,
      direction: 'out',
      from: 'fe-1',
      to: ['qa'],
      text: 'Ready',
    });
    expect(sentTeamMessage({ to: 'qa', message: 'Old field' }, 'a2', ts, null)).toMatchObject({
      from: UNKNOWN_MEMBER,
      to: ['qa'],
      text: 'Old field',
    });
    expect(undeliveredTeamMessage('Error: unknown recipient\nmore', 'r1', ts)).toEqual({
      kind: 'system_note',
      id: 'r1',
      ts,
      text: 'Team message not delivered: Error: unknown recipient',
    });
  });
});

describe('ToolNames', () => {
  it('forgets the oldest names beyond its size', () => {
    const tools = new ToolNames(2);
    tools.remember('c1', 'Bash');
    tools.remember('c2', 'Read');
    tools.remember('c3', 'Edit');
    expect(tools.get('c1')).toBeNull();
    expect(tools.get('c2')).toBe('Read');
    expect(tools.get('c3')).toBe('Edit');
  });
});

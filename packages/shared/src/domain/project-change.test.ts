import { describe, expect, it } from 'vitest';
import {
  ProjectChangeEventsQuery,
  decodeProjectEventCursor,
  encodeProjectEventCursor,
} from './project-change';

const base64url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('project event cursor', () => {
  it('round-trips and carries the seq as a decimal string', () => {
    const cursor = { generation: 'abc123', projectKey: 'AR', seq: 9_007_199_254_740_991 };
    const text = encodeProjectEventCursor(cursor);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/')))).toEqual({
      version: 1,
      generation: 'abc123',
      projectKey: 'AR',
      seq: '9007199254740991',
    });
    expect(decodeProjectEventCursor(text)).toEqual(cursor);
    expect(decodeProjectEventCursor(encodeProjectEventCursor({ ...cursor, seq: 0 }))?.seq).toBe(0);
  });

  it('refuses what is not exactly a version 1 cursor', () => {
    const valid = { version: 1, generation: 'g', projectKey: 'AR', seq: '5' };
    expect(decodeProjectEventCursor(base64url(JSON.stringify(valid)))).not.toBeNull();
    const bad: unknown[] = [
      { ...valid, version: 2 },
      { ...valid, seq: 5 },
      { ...valid, seq: '05' },
      { ...valid, seq: '-1' },
      { ...valid, seq: '1.5' },
      { ...valid, seq: '1e3' },
      { ...valid, seq: ' 5' },
      { ...valid, seq: '9007199254740992' },
      { ...valid, seq: '99999999999999999999' },
      { ...valid, generation: '' },
      { ...valid, extra: true },
      { version: 1, projectKey: 'AR', seq: '5' },
      { seq: '5', projectKey: 'AR', generation: 'g', version: 1 },
      [],
      null,
      'text',
    ];
    for (const value of bad)
      expect(decodeProjectEventCursor(base64url(JSON.stringify(value))), JSON.stringify(value)).toBeNull();
    for (const text of [
      '',
      'not a cursor',
      '%%%',
      '!!',
      base64url('{'),
      `${base64url(JSON.stringify(valid))}=`,
    ])
      expect(decodeProjectEventCursor(text), text).toBeNull();
  });
});

describe('project events query', () => {
  it('bounds the page and the wait', () => {
    expect(ProjectChangeEventsQuery.parse({})).toEqual({ limit: 100, waitMs: 25_000 });
    expect(ProjectChangeEventsQuery.parse({ limit: '500', waitMs: '0', after: 'x' })).toEqual({
      limit: 500,
      waitMs: 0,
      after: 'x',
    });
    for (const bad of [
      { limit: '0' },
      { limit: '501' },
      { waitMs: '-1' },
      { waitMs: '25001' },
      { limit: '1.5' },
    ])
      expect(ProjectChangeEventsQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

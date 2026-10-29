import { describe, expect, it } from 'vitest';
import { RELEASE_TAG_PATTERN, releaseTagName } from './release';

describe('releaseTagName', () => {
  const day = new Date('2026-10-11T23:59:59Z');

  it('names the tag after the UTC date, without leading zeros', () => {
    expect(releaseTagName(day, [])).toBe('v2026.10.11');
    expect(releaseTagName(new Date('2026-03-05T00:00:00Z'), [])).toBe('v2026.3.5');
    // The UTC date counts, not the local one.
    expect(releaseTagName(new Date('2026-12-31T23:30:00Z'), [])).toBe('v2026.12.31');
  });

  it('adds a counter from 2 when the date already has a tag', () => {
    expect(releaseTagName(day, ['v2026.10.11'])).toBe('v2026.10.11.2');
    expect(releaseTagName(day, ['v2026.10.11', 'v2026.10.11.2'])).toBe('v2026.10.11.3');
  });

  it('ignores tags of other days and fills no gap behind a taken counter', () => {
    expect(releaseTagName(day, ['v2026.10.10', 'v2026.9.11'])).toBe('v2026.10.11');
    expect(releaseTagName(day, ['v2026.10.11', 'v2026.10.11.3'])).toBe('v2026.10.11.2');
  });

  it('always produces a tag the pattern accepts', () => {
    expect(RELEASE_TAG_PATTERN.test(releaseTagName(day, []))).toBe(true);
    expect(RELEASE_TAG_PATTERN.test(releaseTagName(day, ['v2026.10.11']))).toBe(true);
    expect(RELEASE_TAG_PATTERN.test('latest')).toBe(false);
  });
});

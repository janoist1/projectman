import { describe, expect, it } from 'vitest';
import { AdministrationCommandSchema, AdministrationTargetSchema } from './administration';

const COMMIT = 'a'.repeat(40);
const parses = (value: unknown) => AdministrationCommandSchema.safeParse(value).success;

describe('administration command schema (shared with the super-mode handoff)', () => {
  it('accepts the four commands in their exact shape', () => {
    expect(parses({ kind: 'restart', target: { kind: 'hub' }, expectedBootId: 'boot-1' })).toBe(true);
    expect(
      parses({
        kind: 'restart',
        target: { kind: 'engine', id: 'eng_abcdefghij12' },
        expectedBootId: 'boot-1',
      }),
    ).toBe(true);
    expect(parses({ kind: 'full_test', taskKey: 'PM-1', commit: COMMIT, profile: 'merge-test' })).toBe(true);
    expect(
      parses({
        kind: 'image_build',
        taskKey: 'PM-1',
        commit: COMMIT,
        platforms: ['linux/amd64', 'linux/arm64'],
      }),
    ).toBe(true);
    expect(parses({ kind: 'deploy', releaseId: 'rel_1' })).toBe(true);
  });

  it('rejects an unknown key, an unknown kind and a loose target', () => {
    expect(parses({ kind: 'deploy', releaseId: 'rel_1', path: '/x' })).toBe(false);
    expect(parses({ kind: 'shell', command: 'ls' })).toBe(false);
    expect(parses({ kind: 'restart', target: { kind: 'hub', extra: 1 }, expectedBootId: 'boot-1' })).toBe(
      false,
    );
    expect(AdministrationTargetSchema.safeParse({ kind: 'other' }).success).toBe(false);
  });

  it('keeps the commit, boot id, release id and platform limits', () => {
    const full = { kind: 'full_test', taskKey: 'PM-1', profile: 'full-test' };
    expect(parses({ ...full, commit: 'a'.repeat(39) })).toBe(false);
    expect(parses({ ...full, commit: 'A'.repeat(40) })).toBe(false);
    expect(parses({ ...full, commit: 'main' })).toBe(false);
    expect(parses({ ...full, commit: COMMIT, profile: 'other' })).toBe(false);
    expect(parses({ kind: 'restart', target: { kind: 'hub' }, expectedBootId: 'a b' })).toBe(false);
    expect(parses({ kind: 'restart', target: { kind: 'hub' }, expectedBootId: 'x'.repeat(129) })).toBe(false);
    expect(parses({ kind: 'deploy', releaseId: '../x' })).toBe(false);
    expect(parses({ kind: 'deploy', releaseId: 'x'.repeat(65) })).toBe(false);
    const build = { kind: 'image_build', taskKey: 'PM-1', commit: COMMIT };
    expect(parses({ ...build, platforms: [] })).toBe(false);
    expect(parses({ ...build, platforms: ['linux/amd64', 'linux/amd64'] })).toBe(false);
    expect(parses({ ...build, platforms: ['linux/amd64', 'linux/arm64', 'linux/amd64'] })).toBe(false);
    expect(parses({ ...build, platforms: ['windows/amd64'] })).toBe(false);
  });
});

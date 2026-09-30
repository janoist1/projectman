import {
  HumanAccess,
  InboxKind,
  InboxResolutionRule,
  MemberStatus,
  PermissionMode,
  SessionState,
  StageKind,
  TaskLinkKind,
  TaskStatus,
  Visibility,
} from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { hu } from './hu';
import { hasMessage, joinNames, t, tDynamic } from './t';

/** Every source file of the app except tests, as raw text. */
const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function leaves(node: unknown, path: string[] = []): Array<[string, unknown]> {
  if (typeof node !== 'object' || node === null) return [[path.join('.'), node]];
  return Object.entries(node).flatMap(([key, value]) => leaves(value, [...path, key]));
}

describe('hu locale', () => {
  it('scans the app sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(30);
  });

  it('has every key the code passes to t()', () => {
    const missing: string[] = [];
    const pattern = /\bt\(\s*['"]([A-Za-z0-9_.-]+)['"]/g;
    for (const [file, source] of Object.entries(sources)) {
      for (const match of stripComments(source).matchAll(pattern)) {
        if (!hasMessage(match[1]!)) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('labels every enum value the UI shows', () => {
    const expectKeys = (prefix: string, values: readonly string[]) => {
      const missing = values.filter((value) => !hasMessage(`${prefix}.${value}`));
      expect(missing, prefix).toEqual([]);
    };
    expectKeys('memberStatus', MemberStatus.options);
    expectKeys('sessionState', SessionState.options);
    expectKeys('inbox.kinds', InboxKind.options);
    expectKeys('inbox.kindsLower', InboxKind.options);
    expectKeys('stageKinds', StageKind.options);
    // Checks were replaced by labels; old timeline events still name them.
    expectKeys('timeline.legacyChecks.names', ['code_review', 'security_review', 'qa', 'client_test']);
    expectKeys('timeline.legacyChecks.states', ['pending', 'passed', 'blocked', 'failed', 'retest_needed']);
    expectKeys('roles.human', HumanAccess.options);
    expectKeys('permissionModes', PermissionMode.options);
    expectKeys('taskStatus.statuses', TaskStatus.options);
    expectKeys('links.kinds', TaskLinkKind.options);
    expectKeys('visibility', Visibility.options);
    expectKeys('inbox.options', ['allow', 'allow_session', 'deny', 'approve', 'reject', 'answer']);
    expectKeys('inbox.resolutions', ['allow', 'allow_session', 'deny', 'approve', 'reject', 'answer']);
    expectKeys('inbox.resolutionRules', InboxResolutionRule.options);
  });

  it('contains only non-empty strings', () => {
    const bad = leaves(hu).filter(([, value]) => typeof value !== 'string' || value.trim() === '');
    expect(bad).toEqual([]);
  });

  it('keeps Hungarian text out of the code (only hu.ts and mock data hold it)', () => {
    const accented = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/;
    const offenders = Object.entries(sources)
      .filter(([file]) => file !== './hu.ts' && !file.includes('/mocks/'))
      .flatMap(([file, source]) =>
        stripComments(source)
          .split('\n')
          .map((line, index) => ({ file, line: index + 1, text: line.trim() }))
          .filter(({ text }) => accented.test(text)),
      );
    expect(offenders).toEqual([]);
  });
});

describe('t()', () => {
  it('interpolates parameters', () => {
    expect(t('time.daysAgo', { count: 3 })).toBe('3 napja');
    expect(t('taskStatus.needsYou', { what: 'kérdés' })).toBe('Rád vár: kérdés');
  });

  it('translates runtime keys with a fallback', () => {
    expect(tDynamic('templates.small-team.name', 'small-team')).toBe('Kis csapat');
    expect(tDynamic('templates.unknown.name', 'unknown')).toBe('unknown');
  });

  it('joins names the Hungarian way', () => {
    expect(joinNames(['Kata'])).toBe('Kata');
    expect(joinNames(['Kata', 'Bence'])).toBe('Kata és Bence');
    expect(joinNames(['Te', 'Kata', 'Bence'])).toBe('Te, Kata és Bence');
  });
});

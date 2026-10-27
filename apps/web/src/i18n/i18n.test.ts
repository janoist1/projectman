import {
  Approver,
  HumanAccess,
  InboxKind,
  InboxResolutionRule,
  LabelChangeReason,
  MemberStatus,
  PermissionMode,
  SessionState,
  StageKind,
  TaskLinkKind,
  TaskStatus,
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

// Runtime keys without a literal prefix at the call site. Keep these scoped to the
// producer: API template metadata, timeline helpers and outage sections respectively.
const dynamicPrefixes = [
  'templates.',
  'timeline.events.release_changed.',
  'inbox.alerts.work_outage.todo.',
  'inbox.alerts.work_outage.affected.',
  // vite-plugin-pwa.ts reads locale objects directly when building static assets.
  'pwa.',
];

function unusedKeys(keys: string[], appSources: Record<string, string>): string[] {
  const literals = new Set<string>();
  const templates: RegExp[] = [];
  for (const [file, raw] of Object.entries(appSources)) {
    if (file === './hu.ts' || file.includes('/mocks/')) continue;
    const source = stripComments(raw);
    // Includes lookup tables, conditional arguments and rich(), as well as t().
    for (const match of source.matchAll(/(['"])([A-Za-z0-9_./:-]+)\1|`([A-Za-z0-9_./:-]+)`/g)) {
      literals.add(match[2] ?? match[3]!);
    }
    // A template's static parts constrain both ends, e.g. `group.${id}Hint`.
    // Includes keys assembled before the call (e.g. timeline handoff reasons).
    for (const match of source.matchAll(/`([A-Za-z0-9_.-]+\$\{[^`]+)`/g)) {
      const template = match[1]!;
      const escaped = template
        .split(/\$\{[^}]*\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      templates.push(new RegExp(`^${escaped.join('.+')}$`));
    }
  }
  return keys.filter(
    (key) =>
      !literals.has(key) &&
      !templates.some((pattern) => pattern.test(key)) &&
      !dynamicPrefixes.some((prefix) => key.startsWith(prefix)),
  );
}

function stripComments(source: string): string {
  // Preserve comment markers inside literals (route patterns include "/*").
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[dgimsuvy]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (token) => (token.startsWith('/*') || token.startsWith('//') ? '' : token),
  );
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
    const pattern = /\bt\(\s*(['"`])([A-Za-z0-9_./:-]+)\1/g;
    for (const [file, source] of Object.entries(sources)) {
      for (const match of stripComments(source).matchAll(pattern)) {
        if (!hasMessage(match[2]!)) missing.push(`${file}: ${match[2]}`);
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
    expectKeys('permissionControls.approvers', Approver.options);
    expectKeys('permissionControls.blocked', ['delegation_off', 'no_ai_decider']);
    expectKeys('taskStatus.statuses', TaskStatus.options);
    expectKeys('links.kinds', TaskLinkKind.options);
    expectKeys('inbox.options', ['allow', 'allow_session', 'deny', 'approve', 'reject', 'answer']);
    expectKeys('inbox.resolutions', ['allow', 'allow_session', 'deny', 'approve', 'reject', 'answer']);
    expectKeys('inbox.resolutionRules', InboxResolutionRule.options);
    expectKeys('timeline.labelReasons', LabelChangeReason.options);
  });

  it('contains only non-empty strings', () => {
    const bad = leaves(hu).filter(([, value]) => typeof value !== 'string' || value.trim() === '');
    expect(bad).toEqual([]);
  });

  it('has no unused keys', () => {
    expect(
      unusedKeys(
        leaves(hu).map(([key]) => key),
        sources,
      ),
    ).toEqual([]);
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

describe('unused key guard', () => {
  it('reports an unused key by name', () => {
    expect(unusedKeys(['guard.used', 'guard.unused'], { './screen.ts': "t('guard.used')" })).toEqual([
      'guard.unused',
    ]);
  });

  it('recognizes static templates and keys passed through lookup tables or rich', () => {
    expect(
      unusedKeys(['guard.template', 'guard.lookup', 'guard.rich'], {
        './screen.ts': "t(`guard.template`); const key = 'guard.lookup'; t(key); rich('guard.rich', {})",
      }),
    ).toEqual([]);
  });

  it('preserves dynamic template shapes without exempting sibling keys', () => {
    expect(
      unusedKeys(['guard.knownHint', 'guard.unused'], {
        './screen.ts': 't(`guard.${id}Hint`)',
      }),
    ).toEqual(['guard.unused']);
  });

  it('ignores comments and the locale itself', () => {
    expect(
      unusedKeys(['guard.unused'], {
        './hu.ts': "const key = 'guard.unused'",
        './screen.ts': "// t('guard.unused')\n/* t(`guard.unused`) */",
      }),
    ).toEqual(['guard.unused']);
  });

  it('preserves usages after comment markers inside string literals', () => {
    expect(
      unusedKeys(['guard.used'], {
        './screen.ts': "const route = '/tasks/*'; t('guard.used'); /* comment */",
      }),
    ).toEqual([]);
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

import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { CONFIG_ISSUE_MESSAGES, issueMessage } from './configIssues';

/** The shared invariants' source: its `ConfigIssue['code']` union lists every code they emit. */
const invariantSources = import.meta.glob('../../../../packages/shared/src/config/invariants.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function emittedCodes(): string[] {
  const source = Object.values(invariantSources).join('\n');
  const union = /export interface ConfigIssue \{[\s\S]*?\bcode:([\s\S]*?);/.exec(source)?.[1] ?? '';
  return [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
}

describe('configuration issue messages', () => {
  it('reads the shared invariants', () => {
    expect(emittedCodes()).toEqual(
      expect.arrayContaining(['no_owner', 'unknown_label', 'missing_label_setter', 'duplicate_label']),
    );
  });

  it('translates every code the invariants emit', () => {
    const generic = t('settings.issues.invalid_value');
    const untranslated = emittedCodes().filter(
      (code) => !(code in CONFIG_ISSUE_MESSAGES) || issueMessage({ code, path: '' }) === generic,
    );
    expect(untranslated).toEqual([]);
  });

  it('gives every invariant code its own message', () => {
    const generic = t('settings.issues.invalid_value');
    for (const code of Object.keys(CONFIG_ISSUE_MESSAGES))
      expect(issueMessage({ code, path: 'pipeline' }), code).not.toBe(generic);
  });

  it('translates schema issues by their zod code and falls back for unknown ones', () => {
    expect(issueMessage({ code: 'too_small', path: 'team' })).toBe(t('settings.issues.too_small'));
    expect(issueMessage({ code: 'fictional_code', path: 'team' })).toBe(t('settings.issues.invalid_value'));
  });
});

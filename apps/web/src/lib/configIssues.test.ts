import type { ConfigIssue } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { CONFIG_ISSUE_MESSAGES, issueMessage } from './configIssues';

type Mapped = keyof typeof CONFIG_ISSUE_MESSAGES;
/** Compile-time: the messages cover exactly the shared `ConfigIssue['code']` union. */
const exhaustive: [ConfigIssue['code']] extends [Mapped]
  ? [Mapped] extends [ConfigIssue['code']]
    ? true
    : false
  : false = true;

describe('configuration issue messages', () => {
  it('maps every invariant code of the shared type', () => {
    expect(exhaustive).toBe(true);
    expect(Object.keys(CONFIG_ISSUE_MESSAGES)).toEqual(
      expect.arrayContaining(['no_owner', 'unknown_label', 'missing_label_setter', 'duplicate_label']),
    );
  });

  it('gives every invariant code its own message', () => {
    const generic = t('settings.issues.invalid_value');
    const untranslated = Object.keys(CONFIG_ISSUE_MESSAGES).filter(
      (code) => issueMessage({ code, path: 'pipeline' }) === generic,
    );
    expect(untranslated).toEqual([]);
  });

  it('explains that a Codex member cannot have the mode that switches its sandbox off', () => {
    expect(issueMessage({ code: 'codex_bypass_not_allowed', path: 'team.members[2].permissionMode' })).toBe(
      t('settings.issues.codex_bypass_not_allowed'),
    );
  });

  it('translates schema issues by their zod code and falls back for unknown ones', () => {
    expect(issueMessage({ code: 'too_small', path: 'team' })).toBe(t('settings.issues.too_small'));
    expect(issueMessage({ code: 'fictional_code', path: 'team' })).toBe(t('settings.issues.invalid_value'));
  });
});

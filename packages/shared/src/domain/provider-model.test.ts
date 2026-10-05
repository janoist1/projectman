import { describe, expect, it } from 'vitest';
import { AiMemberConfig, HireMemberRequest, PermissionMode, UpdateMemberRequest } from '../index';
import {
  FALLBACK_PERMISSION_MODE,
  hasPlanUsage,
  modelForProvider,
  PLAN_USAGE_PROVIDERS,
  PROVIDER_PERMISSION_MODES,
  permissionModeFitsProvider,
} from './provider-model';

describe('provider settings contracts', () => {
  it('keeps Gemini models within Gemini and does not report its plan usage', () => {
    expect(modelForProvider('gemini')).toBe('gemini-3.8-flash');
    expect(modelForProvider('gemini', 'gemini-3.1-pro-high')).toBe('gemini-3.1-pro-high');
    expect(modelForProvider('gemini', 'claude-opus')).toBe('gemini-3.8-flash');
    expect(modelForProvider('codex', 'gemini-3.8-flash')).toBe('gpt-6.1-sol');
    expect(modelForProvider('claude', 'gemini-3.8-flash')).toBe('opus');
    expect(permissionModeFitsProvider('gemini', 'bypassPermissions')).toBe(false);
    expect(hasPlanUsage('gemini')).toBe(false);
  });
  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'accepts effort %s on config, hire and update',
    (effort) => {
      const member = {
        kind: 'ai',
        handle: 'acme-dev',
        displayName: 'Acme developer',
        role: 'developer',
        sponsor: 'owner',
        effort,
      };
      expect(AiMemberConfig.parse(member).effort).toBe(effort);
      expect(HireMemberRequest.parse({ role: 'developer', provider: 'codex', effort }).effort).toBe(effort);
      expect(UpdateMemberRequest.parse({ provider: 'codex', effort })).toEqual({ provider: 'codex', effort });
    },
  );
  it('accepts legacy settings and rejects unsupported providers and efforts', () => {
    expect(UpdateMemberRequest.parse({ displayName: 'Acme' })).toEqual({ displayName: 'Acme' });
    expect(UpdateMemberRequest.safeParse({ provider: 'other' }).success).toBe(false);
    for (const schema of [AiMemberConfig, HireMemberRequest, UpdateMemberRequest]) {
      expect(
        schema.safeParse({
          kind: 'ai',
          handle: 'acme-dev',
          displayName: 'Acme',
          role: 'developer',
          sponsor: 'owner',
          effort: 'unsupported',
        }).success,
      ).toBe(false);
    }
  });
  it('accepts null only on update to clear effort', () => {
    expect(UpdateMemberRequest.parse({ effort: null })).toEqual({ effort: null });
    expect(HireMemberRequest.safeParse({ role: 'developer', effort: null }).success).toBe(false);
  });
  it('resets incompatible models and keeps provider-specific ids', () => {
    for (const model of ['opus', 'sonnet', 'haiku', 'claude-opus-4-1', 'opus[1m]']) {
      expect(modelForProvider('codex', model)).toBe('gpt-6.1-sol');
      expect(modelForProvider('claude', model)).toBe(model);
    }
    for (const model of ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra', 'fictional-codex-model']) {
      expect(modelForProvider('claude', model)).toBe('opus');
      expect(modelForProvider('codex', model)).toBe(model);
    }
  });
});

describe('permission modes per provider', () => {
  it('offers Claude members every mode and Codex members every mode but bypassPermissions', () => {
    expect(PROVIDER_PERMISSION_MODES.claude).toEqual(PermissionMode.options);
    expect(PROVIDER_PERMISSION_MODES.codex).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
    expect(permissionModeFitsProvider('claude', 'bypassPermissions')).toBe(true);
    expect(permissionModeFitsProvider('codex', 'bypassPermissions')).toBe(false);
    for (const mode of PROVIDER_PERMISSION_MODES.codex) {
      expect(permissionModeFitsProvider('codex', mode)).toBe(true);
    }
  });

  it('measures the plan usage of Claude and Codex (PM-324)', () => {
    expect(PLAN_USAGE_PROVIDERS).toEqual(['claude', 'codex']);
    expect(hasPlanUsage('claude')).toBe(true);
    expect(hasPlanUsage('codex')).toBe(true);
    expect(hasPlanUsage('fictional' as never)).toBe(false);
  });

  it('has a fallback every provider allows', () => {
    for (const provider of ['claude', 'codex'] as const) {
      expect(permissionModeFitsProvider(provider, FALLBACK_PERMISSION_MODE)).toBe(true);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { AiMemberConfig, HireMemberRequest, UpdateMemberRequest } from '../index';
import { modelForProvider } from './provider-model';

describe('provider settings contracts', () => {
  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
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
          effort: 'max',
        }).success,
      ).toBe(false);
    }
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

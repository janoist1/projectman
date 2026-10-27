import { describe, expect, it } from 'vitest';
import type { IntegratorCredentialAuthority } from '../../contracts';
import { createOperatorAppCredentials } from './app';

describe('the credential authority of the in-app Operator', () => {
  const credentialsOver = (base: IntegratorCredentialAuthority | undefined) =>
    createOperatorAppCredentials({
      base,
      sessions: { active: () => false },
      user: () => null,
      userByEmail: () => null,
    });

  it('asks the stored-key authority who the host owner is, and says nobody is without one (PM-1061)', () => {
    const base: IntegratorCredentialAuthority = {
      assertActive: () => {},
      user: () => null,
      isHostOwner: (userId) => userId === 'usr_host',
    };
    const { authority } = credentialsOver(base);
    expect(authority.isHostOwner?.('usr_host')).toBe(true);
    expect(authority.isHostOwner?.('usr_pat')).toBe(false);
    expect(credentialsOver(undefined).authority.isHostOwner?.('usr_host')).toBe(false);
  });
});

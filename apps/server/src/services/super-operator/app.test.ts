import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import type { IntegratorCredentialAuthority } from '../../contracts';
import { createOperatorAppCredentials } from './app';

describe('the credential authority of the in-app Operator', () => {
  const credentialsOver = (
    base: IntegratorCredentialAuthority | undefined,
    openRequest: (sessionId: string) => { source: string; fromHandle: string } | null = () => null,
  ) =>
    createOperatorAppCredentials({
      base,
      sessions: { active: () => false },
      openRequest,
      user: () => null,
      userByEmail: (email) => ({ id: 'usr_owner', email }),
    });

  describe('the request origin of an app principal (PM-1010)', () => {
    const config = {
      team: {
        members: [{ kind: 'human', handle: 'owner', access: 'owner', email: 'owner@example.com' }],
      },
    } as unknown as ProjectConfig;

    it.each([
      [{ source: 'message', fromHandle: 'owner' }, 'owner'],
      [{ source: 'queue', fromHandle: 'owner' }, 'member'],
      [null, 'member'],
    ] as const)('takes it from the open request %j: %s', (request, origin) => {
      const principal = credentialsOver(undefined, () => request).issue(config, 'ses_1', 'operator');
      expect(principal?.requestOrigin).toBe(origin);
    });

    it('is the owner`s after the owner`s yes, whatever the session`s request was', () => {
      const principal = credentialsOver(undefined, () => ({
        source: 'queue',
        fromHandle: 'dev-1',
      })).issueApproved(config, 'ses_1', 'owner', 'operator');
      expect(principal?.requestOrigin).toBe('owner');
    });
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

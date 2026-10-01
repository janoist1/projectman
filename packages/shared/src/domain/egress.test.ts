import { describe, expect, it } from 'vitest';
import { boundaryCategory } from './boundary';
import {
  allowanceCovers,
  egressResource,
  egressTarget,
  normalizeEgressHost,
  parseEgressAuthority,
} from './egress';
import type { EgressAllowance, EgressOperation } from './egress';

describe('egress destinations', () => {
  it('normalizes hosts and refuses what cannot be a destination', () => {
    expect(normalizeEgressHost('Registry.NPMJS.org.')).toBe('registry.npmjs.org');
    expect(normalizeEgressHost('140.82.112.3')).toBe('140.82.112.3');
    for (const bad of ['', '*.example.org', 'exa mple.org', '-x.org', 'a..b', '::1', 'host:443', 'é.org'])
      expect(normalizeEgressHost(bad), bad).toBeNull();
  });

  it('parses CONNECT authorities: host and port only, no IPv6 literal', () => {
    expect(parseEgressAuthority('GitHub.com:443')).toEqual({ host: 'github.com', port: 443 });
    for (const bad of [
      'github.com',
      'github.com:0',
      'github.com:70000',
      '[::1]:443',
      'a:b:443',
      'user@github.com:443',
    ])
      expect(parseEgressAuthority(bad), bad).toBeNull();
  });

  const operation: EgressOperation = {
    id: 'egr_1',
    projectKey: 'AR',
    member: 'dev',
    sessionId: 'ses_1',
    taskKey: 'AR-1',
    host: 'docs.example.org',
    port: 443,
    createdAt: '2026-10-01T10:00:00.000Z',
    expiresAt: '2026-10-01T18:00:00.000Z',
  };

  it('describes an operation as a delegable development read of one destination', () => {
    const target = egressTarget(operation);
    expect(target).toEqual({
      operation: 'read_external',
      resource: 'egress:docs.example.org:443',
      environment: 'development',
      branch: null,
      protectedBranch: false,
      scope: 'single_operation',
      expiresAt: '2026-10-01T18:00:00.000Z',
      policyVersion: 'egress-1',
    });
    expect(boundaryCategory(target)).toBe('delegable');
    expect(egressResource({ host: '1.2.3.4', port: 8443 })).toBe('egress:1.2.3.4:8443');
  });

  it('opens an allowance for its member, project, host and port until it expires or is revoked', () => {
    const allowance: EgressAllowance = {
      id: 'egw_1',
      projectKey: 'AR',
      member: 'dev',
      host: 'docs.example.org',
      port: 443,
      requestId: 'bnd_1',
      operationId: 'egr_1',
      grantedAt: '2026-10-01T10:00:00.000Z',
      expiresAt: '2026-10-01T18:00:00.000Z',
      revokedAt: null,
      revokedBy: null,
    };
    const scope = { projectKey: 'AR', member: 'dev' };
    const dest = { host: 'docs.example.org', port: 443 };
    const at = Date.parse('2026-10-01T12:00:00.000Z');
    expect(allowanceCovers(allowance, scope, dest, at)).toBe(true);
    expect(allowanceCovers(allowance, { ...scope, member: 'qa' }, dest, at)).toBe(false);
    expect(allowanceCovers(allowance, { ...scope, projectKey: 'PM' }, dest, at)).toBe(false);
    expect(allowanceCovers(allowance, scope, { ...dest, port: 80 }, at)).toBe(false);
    expect(allowanceCovers(allowance, scope, dest, Date.parse(allowance.expiresAt))).toBe(false);
    expect(allowanceCovers({ ...allowance, revokedAt: '2026-10-01T11:00:00.000Z' }, scope, dest, at)).toBe(
      false,
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  CreateIntegratorAccessKeyRequest,
  CreateIntegratorKeyRequest,
  IntegratorAccessKeyInfo,
  IntegratorKeyAuditQuery,
  IntegratorKeyInfo,
} from './dto';

describe('integrator credential contracts', () => {
  it('keeps issuance defaults and supports long-lived and non-expiring explicit modes', () => {
    expect(CreateIntegratorKeyRequest.parse({})).toEqual({ expiresInDays: 90 });
    expect(CreateIntegratorKeyRequest.parse({ expiresInDays: null })).toEqual({ expiresInDays: null });
    for (const mode of ['super', 'read']) {
      expect(CreateIntegratorAccessKeyRequest.parse({ mode })).toEqual({ mode, expiresInDays: 7 });
      for (const expiresInDays of [1, 7, 30, 365, null])
        expect(CreateIntegratorAccessKeyRequest.parse({ mode, expiresInDays })).toEqual({
          mode,
          expiresInDays,
        });
    }
    for (const input of [
      {},
      { mode: 'legacy' },
      { mode: 'super', expiresInDays: 0 },
      { mode: 'read', expiresInDays: 90 },
      { mode: 'super', expiresInDays: '365' },
      { mode: 'read', expiresInDays: 'never' },
    ])
      expect(CreateIntegratorAccessKeyRequest.safeParse(input).success).toBe(false);
  });

  it('requires a nullable channel only in the new access key view', () => {
    const legacy = {
      prefix: 'pmi_example',
      state: 'active',
      createdAt: '2026-10-17',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    expect(IntegratorKeyInfo.parse(legacy)).toEqual(legacy);
    const key = { ...legacy, id: 'key-1', mode: 'legacy' };
    expect(IntegratorAccessKeyInfo.safeParse(key).success).toBe(false);
    for (const lastUsedChannel of [null, 'mcp', 'cli', 'rest'])
      expect(IntegratorAccessKeyInfo.parse({ ...key, lastUsedChannel })).toEqual({ ...key, lastUsedChannel });
    expect(IntegratorAccessKeyInfo.safeParse({ ...key, lastUsedChannel: 'unknown' }).success).toBe(false);
  });

  it('bounds numeric lifecycle audit cursors and page size', () => {
    expect(IntegratorKeyAuditQuery.parse({})).toEqual({ limit: 50 });
    expect(IntegratorKeyAuditQuery.parse({ before: '42', limit: '100' })).toEqual({ before: 42, limit: 100 });
    for (const input of [{ before: 0 }, { before: 'x' }, { limit: 0 }, { limit: 101 }])
      expect(IntegratorKeyAuditQuery.safeParse(input).success).toBe(false);
  });
});

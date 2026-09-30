import { SetupStatus } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest, onUnauthorized, setFetchImplementation } from './client';
import { errorMessage, isApprovalRequested } from '../lib/errors';

function respond(status: number, body: unknown) {
  setFetchImplementation(
    async () =>
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

afterEach(() => {
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

describe('apiRequest', () => {
  it('returns validated data', async () => {
    respond(200, { needsSetup: false });
    await expect(apiRequest('/api/setup', { schema: SetupStatus })).resolves.toEqual({ needsSetup: false });
  });

  it('turns error bodies into ApiError with the server code', async () => {
    respond(409, {
      error: {
        code: 'approval_requested',
        message: 'approvers were asked',
        details: { approvers: ['owner'] },
      },
    });
    const error = await apiRequest('/api/x', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'approval_requested',
      details: { approvers: ['owner'] },
    });
    expect(isApprovalRequested(error)).toBe(true);
    expect(errorMessage(error)).toBe('Jóváhagyást kértünk; a feladat a jóváhagyás után lép tovább.');
  });

  it('notifies about 401 responses', async () => {
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    respond(401, { error: { code: 'unauthorized', message: 'login required' } });
    await expect(apiRequest('/api/me')).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('rejects responses that break the contract (development builds)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    respond(200, { needsSetup: 'yes' });
    await expect(apiRequest('/api/setup', { schema: SetupStatus })).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(error).toHaveBeenCalled();
  });

  it('reports network failures as ApiError', async () => {
    setFetchImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = await apiRequest('/api/me').catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'network_error' });
    expect(errorMessage(error)).toBe('Nem érem el a szervert.');
  });

  it('handles empty 204 responses', async () => {
    respond(204, null);
    await expect(apiRequest('/api/auth/logout', { method: 'POST' })).resolves.toBeNull();
  });
});

describe('list responses', () => {
  it('validates a bare array item by item and rejects anything else', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    respond(200, [{ needsSetup: true }]);
    await expect(apiRequest('/x', { schema: SetupStatus.array() })).resolves.toHaveLength(1);
    respond(200, { items: [{ needsSetup: true }] });
    await expect(apiRequest('/x', { schema: SetupStatus.array() })).rejects.toMatchObject({
      code: 'invalid_response',
    });
    respond(200, [{ needsSetup: 'yes' }]);
    await expect(apiRequest('/x', { schema: SetupStatus.array() })).rejects.toBeInstanceOf(ApiError);
  });
});

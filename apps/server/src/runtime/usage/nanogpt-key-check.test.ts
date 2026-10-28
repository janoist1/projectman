import { describe, expect, it, vi } from 'vitest';
import { createNanogptKeyCheck } from './nanogpt-key-check';

describe('NanoGPT key check', () => {
  it.each([
    [200, 'accepted'],
    [204, 'accepted'],
    [401, 'rejected'],
    [403, 'rejected'],
    [400, 'unknown'],
    [429, 'unknown'],
    [500, 'unknown'],
  ])('maps HTTP %s to %s without reading the balance', async (status, result) => {
    const response = new Response(null, { status: status as number });
    const json = vi.spyOn(response, 'json');
    const fake = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await createNanogptKeyCheck(fake)('fake-key')).toBe(result);
    expect(fake).toHaveBeenCalledWith(
      'https://api.nano-gpt.com/api/check-balance',
      expect.objectContaining({
        method: 'POST',
        headers: { 'x-api-key': 'fake-key' },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(json).not.toHaveBeenCalled();
  });
  it('treats network errors and timeouts as unknown', async () => {
    const fake = vi.fn<typeof fetch>().mockRejectedValue(new Error('fake-key'));
    expect(await createNanogptKeyCheck(fake)('fake-key')).toBe('unknown');
    fake.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    expect(await createNanogptKeyCheck(fake)('fake-key')).toBe('unknown');
  });
});

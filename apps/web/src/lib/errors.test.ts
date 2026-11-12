import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { codeMessage, failText } from './errors';

describe('failText', () => {
  it('shows the server text of a known error code and the fallback otherwise', () => {
    expect(failText(new ApiError(429, 'web_push_test_too_soon', 'x'), 'fallback')).toBe(
      codeMessage('web_push_test_too_soon'),
    );
    expect(failText(new ApiError(500, 'something_unknown', 'x'), 'fallback')).toBe('fallback');
    expect(failText(new Error('boom'), 'fallback')).toBe('fallback');
  });
});

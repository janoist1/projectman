import { describe, expect, it } from 'vitest';
import { parseHistorySemantic } from '../src/start';

describe('PROJECTMAN_HISTORY_SEMANTIC default (PM-1105)', () => {
  it.each([
    ['single', undefined, true],
    ['single', 'off', false],
    ['cloud', undefined, false],
    ['cloud', '', false],
    ['cloud', 'on', true],
    ['cloud', 'off', false],
  ] as const)('%s mode with %j enables the worker: %s', (mode, flag, enabled) => {
    const env = flag === undefined ? {} : { PROJECTMAN_HISTORY_SEMANTIC: flag };
    expect(parseHistorySemantic(env, mode).enabled).toBe(enabled);
  });

  it('refuses any other value', () => {
    expect(() => parseHistorySemantic({ PROJECTMAN_HISTORY_SEMANTIC: 'maybe' }, 'cloud')).toThrow(
      /invalid PROJECTMAN_HISTORY_SEMANTIC/,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { isLoopbackHost, loopbackBaseUrl } from '../src/app';

describe('composition root', () => {
  it('reaches hooks and MCP on the loopback address the server listens on', () => {
    expect(loopbackBaseUrl('127.0.0.1', 4700)).toBe('http://127.0.0.1:4700');
    expect(loopbackBaseUrl('localhost', 4701)).toBe('http://127.0.0.1:4701');
    expect(loopbackBaseUrl('::1', 4702)).toBe('http://[::1]:4702');
  });

  it('accepts only loopback hosts', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['0.0.0.0', '::', '', '192.168.1.2']) expect(isLoopbackHost(host)).toBe(false);
  });
});

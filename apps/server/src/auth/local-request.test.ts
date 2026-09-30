import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isLocalRequest } from './local-request';

const request = (remoteAddress: string | undefined, headers: IncomingHttpHeaders = {}) => ({
  socket: { remoteAddress } as never,
  headers: { host: '127.0.0.1:4700', ...headers },
});

describe('isLocalRequest', () => {
  it.each(['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'])('accepts a loopback peer %s', (address) => {
    expect(isLocalRequest(request(address))).toBe(true);
  });

  it.each([undefined, '100.64.0.7', '192.168.1.20', '::ffff:10.0.0.1'])(
    'rejects the remote peer %s',
    (address) => {
      expect(isLocalRequest(request(address))).toBe(false);
    },
  );

  it.each(['localhost:4700', '[::1]:4700', '127.0.0.1'])('accepts the loopback Host %s', (host) => {
    expect(isLocalRequest(request('127.0.0.1', { host }))).toBe(true);
  });

  it.each(['evil.example', 'mac.tail1234.ts.net', '127.0.0.1.nip.io'])(
    'rejects the Host %s (DNS rebinding)',
    (host) => {
      expect(isLocalRequest(request('127.0.0.1', { host }))).toBe(false);
    },
  );

  it('accepts a request a local dev proxy forwarded through loopback hops only', () => {
    expect(isLocalRequest(request('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, ::1' }))).toBe(true);
    expect(isLocalRequest(request('127.0.0.1', { forwarded: 'for="[::1]";proto=http' }))).toBe(true);
    expect(isLocalRequest(request('127.0.0.1', { 'x-real-ip': 'localhost' }))).toBe(true);
  });

  it('rejects requests relayed for a remote client or carrying a Tailscale identity', () => {
    expect(isLocalRequest(request('127.0.0.1', { 'x-forwarded-for': '100.64.0.7' }))).toBe(false);
    expect(isLocalRequest(request('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 100.64.0.7' }))).toBe(false);
    expect(isLocalRequest(request('127.0.0.1', { forwarded: 'for=100.64.0.7' }))).toBe(false);
    expect(isLocalRequest(request('127.0.0.1', { 'tailscale-user-login': 'anna@example.test' }))).toBe(false);
  });
});

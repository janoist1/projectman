import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import { clientAddress, isLocalRequest } from './local-request';

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

describe('clientAddress', () => {
  const HEADER = 'cf-connecting-ip';
  const via = (value: string | string[] | undefined, peer: string, header: string | undefined) =>
    clientAddress({ ...request(peer, { [HEADER]: value }), ip: peer }, header);
  const through = (value: string | string[] | undefined, peer = '127.0.0.1') => via(value, peer, HEADER);

  it('uses the connection address when no header is configured', () => {
    expect(via('203.0.113.9', '127.0.0.1', undefined)).toBe('127.0.0.1');
    expect(via('203.0.113.9', '127.0.0.1', '')).toBe('127.0.0.1');
  });

  it('uses the configured header from a loopback peer, whatever the header name case', () => {
    expect(through('203.0.113.9')).toBe('203.0.113.9');
    expect(via('203.0.113.9', '127.0.0.1', 'CF-Connecting-IP')).toBe('203.0.113.9');
    expect(through('203.0.113.9', '::1')).toBe('203.0.113.9');
    expect(through('2001:db8::7')).toBe('2001:db8::7');
  });

  it('writes one address one way', () => {
    expect(through('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(through('2001:DB8:0:0:0:0:0:7')).toBe('2001:db8::7');
    expect(through('0:0:0:0:0:0:0:1')).toBe('::1');
  });

  it('ignores the header from a peer that is not loopback', () => {
    expect(through('203.0.113.9', '100.64.0.7')).toBe('100.64.0.7');
  });

  it.each([undefined, '', ' ', 'unknown', '203.0.113.9, 198.51.100.1', '203.0.113.256', '203.0.113.9:443'])(
    'falls back to the connection address for the header %j',
    (value) => {
      expect(through(value)).toBe('127.0.0.1');
    },
  );

  it('falls back for a repeated header and a scoped IPv6 address', () => {
    expect(through(['203.0.113.9', '198.51.100.1'])).toBe('127.0.0.1');
    expect(through('fe80::1%en0')).toBe('127.0.0.1');
  });

  it('never reads X-Forwarded-For', () => {
    const forwarded = { ...request('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), ip: '127.0.0.1' };
    expect(clientAddress(forwarded, HEADER)).toBe('127.0.0.1');
    expect(clientAddress(forwarded, undefined)).toBe('127.0.0.1');
  });
});

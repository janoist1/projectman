import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { clientAddress, ipRateLimitKey, isLocalRequest, requestProtocol } from './local-request';

const request = (remoteAddress: string | undefined, headers: IncomingHttpHeaders = {}) => ({
  socket: { remoteAddress } as never,
  headers: { host: '127.0.0.1:4700', ...headers },
});

describe('requestProtocol', () => {
  const protocol = (peer: string | undefined, value?: string | string[]) =>
    requestProtocol({
      ...request(peer, { 'x-forwarded-proto': value }),
      protocol: 'http',
    } as unknown as FastifyRequest);

  it.each(['100.64.0.5', '203.0.113.7', '::ffff:203.0.113.7', undefined])(
    'ignores forwarded HTTPS from the untrusted peer %s',
    (peer) => {
      expect(protocol(peer, 'https')).toBe('http');
    },
  );

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'trusts only explicit forwarded HTTPS from the loopback peer %s',
    (peer) => {
      expect(protocol(peer, 'https')).toBe('https');
      expect(protocol(peer)).toBe('http');
    },
  );

  it.each<{ value: string | string[] }>([
    { value: 'https,http' },
    { value: 'http' },
    { value: 'HTTPS ' },
    { value: 'https ' },
    { value: 'HTTPS' },
    { value: '' },
    { value: ['https'] },
    { value: ['https', 'http'] },
  ])('rejects the non-exact forwarded protocol $value from loopback', ({ value }) => {
    expect(protocol('127.0.0.1', value)).toBe('http');
  });
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

describe('ipRateLimitKey', () => {
  it('shares one canonical key across all addresses in an IPv6 /64', () => {
    expect(ipRateLimitKey('2001:db8:1234:5678::1')).toBe('2001:db8:1234:5678::/64');
    expect(ipRateLimitKey('2001:db8:1234:5678:ffff:abcd:1234:5678')).toBe(
      ipRateLimitKey('2001:db8:1234:5678::1'),
    );
    expect(ipRateLimitKey('2001:db8:1234:5679::1')).not.toBe(ipRateLimitKey('2001:db8:1234:5678::1'));
  });

  it.each([
    ['2001:0DB8:0000:0000:0000:0000:0000:0007', '2001:db8::/64'],
    ['2001:db8::7', '2001:db8::/64'],
    ['::1', '::/64'],
    ['0:0:0:0:0:0:0:1', '::/64'],
    ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ffff:ffff:ffff:ffff::/64'],
    ['::192.0.2.1', '::/64'],
    ['::ffff:0:192.0.2.1', '::/64'],
    ['fe80::7%en0', 'fe80::/64'],
  ])('normalizes IPv6 %s to %s', (ip, expected) => {
    expect(ipRateLimitKey(ip)).toBe(expected);
  });

  it.each(['192.0.2.1', '::ffff:192.0.2.1', '::ffff:c000:201', '0:0:0:0:0:FFFF:C000:0201'])(
    'keeps the full IPv4 address for %s',
    (ip) => {
      expect(ipRateLimitKey(ip)).toBe('192.0.2.1');
      expect(ipRateLimitKey(ip)).not.toBe(ipRateLimitKey('192.0.2.2'));
    },
  );
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

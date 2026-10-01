import { describe, expect, it } from 'vitest';
import { isIpLiteral, isPublicIPv4 } from './addresses';
import { findSocketUid } from './peer';
import { parseClientHello } from './sni';
import { captureClientHello } from './test-helpers';

describe('TLS server names', () => {
  it('reads the server name of a real ClientHello', async () => {
    const hello = await captureClientHello('Registry.NPMJS.org');
    expect(parseClientHello(hello)).toEqual({ status: 'hello', serverName: 'registry.npmjs.org' });
  });

  it('asks for more bytes while the ClientHello is cut short, at every length', async () => {
    const hello = await captureClientHello('example.org');
    for (let length = 1; length < hello.length; length += 7)
      expect(parseClientHello(hello.subarray(0, length)).status).toBe('incomplete');
  });

  it('reports a ClientHello without a server name', async () => {
    // Node sends no SNI for an IP address.
    const hello = await captureClientHello();
    expect(parseClientHello(hello)).toEqual({ status: 'hello', serverName: null });
  });

  it('refuses what is not a TLS handshake (an SSH banner, plain HTTP)', () => {
    expect(parseClientHello(Buffer.from('SSH-2.0-OpenSSH_9.6\r\n')).status).toBe('not_tls');
    expect(parseClientHello(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')).status).toBe('not_tls');
    expect(parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x02, 0, 0, 1, 0])).status).toBe(
      'not_tls',
    );
  });
});

describe('destination addresses', () => {
  it('accepts public IPv4 only', () => {
    expect(isPublicIPv4('93.184.216.34')).toBe(true);
    expect(isPublicIPv4('140.82.112.3')).toBe(true);
    for (const blocked of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.64.1',
      '169.254.169.254',
      '100.64.0.1',
      '100.127.255.254',
      '0.0.0.0',
      '224.0.0.251',
      '255.255.255.255',
      '198.18.0.1',
      '192.0.2.10',
    ])
      expect(isPublicIPv4(blocked), blocked).toBe(false);
    expect(isPublicIPv4('2001:4860:4860::8888')).toBe(false);
    expect(isPublicIPv4('example.org')).toBe(false);
  });

  it('tells IP literals from names', () => {
    expect(isIpLiteral('1.2.3.4')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('example.org')).toBe(false);
  });
});

describe('the socket owner of a loopback connection', () => {
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:12AC 00000000:0000 0A 00000000:00000000 00:00000000 00000000 19000        0 1111 1 0 100 0 0 10 0',
    '   1: 0100007F:D431 0100007F:12AC 01 00000000:00000000 00:00000000 00000000 20001        0 2222 1 0 20 4 30 10 -1',
    '   2: 0100007F:12AC 0100007F:D431 01 00000000:00000000 00:00000000 00000000 19000        0 3333 1 0 20 4 30 10 -1',
  ].join('\n');

  it('finds the uid of the client end, not of the proxy end', () => {
    // The proxy (port 4780 = 0x12AC) sees the client at 127.0.0.1:54321 (0xD431).
    expect(
      findSocketUid(table, { address: '127.0.0.1', port: 54321 }, { address: '127.0.0.1', port: 4780 }),
    ).toBe(20001);
    expect(
      findSocketUid(
        table,
        { address: '::ffff:127.0.0.1', port: 54321 },
        { address: '127.0.0.1', port: 4780 },
      ),
    ).toBe(20001);
  });

  it('finds nothing for an unknown connection or a malformed address', () => {
    expect(
      findSocketUid(table, { address: '127.0.0.1', port: 1 }, { address: '127.0.0.1', port: 4780 }),
    ).toBeNull();
    expect(
      findSocketUid(table, { address: 'nonsense', port: 54321 }, { address: '127.0.0.1', port: 4780 }),
    ).toBeNull();
  });
});

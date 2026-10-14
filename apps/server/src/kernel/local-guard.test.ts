import { describe, expect, it } from 'vitest';
import { isLoopbackAddress, isLoopbackHostHeader, isLoopbackOrigin, nonLocalReason } from './local-guard';

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1'])(
    'accepts %s',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  it.each([
    undefined,
    '',
    '10.0.0.1',
    '192.168.1.20',
    '100.101.102.103',
    '::ffff:10.0.0.1',
    'fe80::1',
    '0.0.0.0',
  ])('rejects %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe('isLoopbackHostHeader', () => {
  it.each(['127.0.0.1:4700', '127.0.0.1', 'localhost:4700', 'LOCALHOST', '[::1]:4700', '[::1]'])(
    'accepts %s',
    (host) => {
      expect(isLoopbackHostHeader(host)).toBe(true);
    },
  );

  it.each([
    undefined,
    '',
    'evil.example:4700',
    'mac.tail1234.ts.net',
    'localhost.evil.example',
    '127.0.0.1.nip.io',
    'evil.example@127.0.0.1',
    '127.0.0.1/evil',
  ])('rejects %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(false);
  });
});

describe('isLoopbackOrigin', () => {
  it.each(['http://localhost:5173', 'http://127.0.0.1:4700', 'https://[::1]:8443'])(
    'accepts %s',
    (origin) => {
      expect(isLoopbackOrigin(origin)).toBe(true);
    },
  );

  it.each(['null', 'https://evil.example', 'http://localhost.evil.example', 'file://localhost', 'garbage'])(
    'rejects %s',
    (origin) => {
      expect(isLoopbackOrigin(origin)).toBe(false);
    },
  );
});

describe('nonLocalReason', () => {
  const local = { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:4700' } };

  it('accepts what the runner configures: http://127.0.0.1:<port>/mcp/<token>', () => {
    expect(nonLocalReason(local)).toBeNull();
  });

  it('names the reason of a rejection', () => {
    expect(nonLocalReason({ ...local, remoteAddress: '10.0.0.2' })).toBe('remote address is not loopback');
    expect(nonLocalReason({ ...local, headers: { ...local.headers, 'x-real-ip': '10.0.0.2' } })).toBe(
      'request was forwarded by a proxy (x-real-ip)',
    );
    expect(nonLocalReason({ ...local, headers: {} })).toBe('host is not a loopback host');
    expect(nonLocalReason({ ...local, headers: { ...local.headers, origin: 'https://evil.example' } })).toBe(
      'origin is not a loopback origin',
    );
  });
});

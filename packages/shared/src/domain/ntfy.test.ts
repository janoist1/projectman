import { describe, expect, it } from 'vitest';
import { instanceOriginOf, ntfyServerOf } from './ntfy';

describe('ntfy server address', () => {
  it.each([
    ['https://ntfy.sh', 'https://ntfy.sh'],
    ['https://NTFY.example.org/', 'https://ntfy.example.org'],
  ])('accepts %s', (value, expected) => expect(ntfyServerOf(value)).toBe(expected));
  it.each([
    'http://ntfy.sh',
    'https://ntfy.sh/topic',
    'https://ntfy.sh/?a=1',
    'https://ntfy.sh:8443',
    'https://user:pass@ntfy.sh',
    'https://127.0.0.1',
    'https://0x7f.1',
    'https://localhost',
    'https://printer.local',
    'https://nas.home.arpa',
    'ntfy.sh',
  ])('refuses %s', (value) => expect(ntfyServerOf(value)).toBeNull());
});
describe('instance origin', () => {
  it('accepts an http or https origin and nothing else', () => {
    expect(instanceOriginOf('https://pm.example')).toBe('https://pm.example');
    expect(instanceOriginOf('http://localhost:4800')).toBe('http://localhost:4800');
    for (const value of [undefined, 'null', 'https://pm.example/path', 'ftp://pm.example'])
      expect(instanceOriginOf(value)).toBeNull();
  });
});

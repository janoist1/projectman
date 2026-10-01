import { describe, expect, it } from 'vitest';
import { assertMappings, mapPath, parsePathMapping } from '../../../scripts/migrate/paths';
import { redactRemoteUrl } from '../../../scripts/migrate/git';

describe('path mappings of the move', () => {
  const mappings = [
    parsePathMapping('/Users/i/Dev/projectman=/var/lib/projectman/data/repos/PM'),
    parsePathMapping('/Users/i/Dev=/srv/dev/'),
  ];

  it('parses FROM=TO, absolute on both sides, without trailing slashes', () => {
    expect(parsePathMapping('/a/b/=/c/d/')).toEqual({ from: '/a/b', to: '/c/d' });
    expect(() => parsePathMapping('a=/b')).toThrow(/absolute/);
    expect(() => parsePathMapping('/a=b')).toThrow(/absolute/);
    expect(() => parsePathMapping('/a')).toThrow(/FROM=TO/);
    expect(() => parsePathMapping('=/a')).toThrow(/FROM=TO/);
  });

  it('uses the longest mapping that contains the path at a segment boundary', () => {
    expect(mapPath('/Users/i/Dev/projectman', mappings)).toBe('/var/lib/projectman/data/repos/PM');
    expect(mapPath('/Users/i/Dev/projectman/apps/web', mappings)).toBe('/var/lib/projectman/data/repos/PM/apps/web');
    expect(mapPath('/Users/i/Dev/other/x', mappings)).toBe('/srv/dev/other/x');
  });

  it('never maps a path that only shares a prefix, a relative path or an unnamed root', () => {
    expect(mapPath('/Users/i/Dev/projectman-live', mappings)).toBe('/srv/dev/projectman-live');
    expect(mapPath('/Users/i/Developer/x', mappings)).toBeNull();
    expect(mapPath('/Users/other/Dev/x', mappings)).toBeNull();
    expect(mapPath('relative/path', mappings)).toBeNull();
  });

  it('normalises the path before mapping, so ".." cannot walk out of a mapping', () => {
    expect(mapPath('/Users/i/Dev/projectman/../other', mappings)).toBe('/srv/dev/other');
  });

  it('refuses the same FROM twice', () => {
    expect(() => assertMappings([parsePathMapping('/a=/b'), parsePathMapping('/a=/c')])).toThrow(/twice/);
  });
});

describe('remote URLs in the inventory', () => {
  it('drops credentials and says so', () => {
    expect(redactRemoteUrl('https://user:ghp_secret@github.com/acme/web.git')).toEqual({
      url: 'https://github.com/acme/web.git',
      hadCredentials: true,
    });
    expect(redactRemoteUrl('https://ghp_token@github.com/acme/web.git').hadCredentials).toBe(true);
  });

  it('keeps URLs without a secret', () => {
    expect(redactRemoteUrl('git@github.com:acme/web.git')).toEqual({ url: 'git@github.com:acme/web.git', hadCredentials: false });
    expect(redactRemoteUrl('ssh://git@github.com/acme/web.git').hadCredentials).toBe(false);
    expect(redactRemoteUrl('/srv/git/web.git').hadCredentials).toBe(false);
  });
});

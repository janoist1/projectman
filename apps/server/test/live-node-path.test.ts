import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isVersionedNodePath, stableNodePath } from '../../../scripts/live/node-path';

/** The `node` of a LaunchAgent (PM-514): a Homebrew upgrade removes the versioned Cellar directory. */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** `<base>/Cellar/node/<version>/bin/node` and `<base>/bin/node` linking to it, as Homebrew lays them out. */
function homebrew(): { cellarNode: string; linkedNode: string; bin: string } {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'live-node-')));
  directories.push(base);
  const cellarNode = path.join(base, 'Cellar', 'node', '23.11.0', 'bin', 'node');
  mkdirSync(path.dirname(cellarNode), { recursive: true });
  writeFileSync(cellarNode, '#!/bin/sh\n', { mode: 0o755 });
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  const linkedNode = path.join(bin, 'node');
  symlinkSync(cellarNode, linkedNode);
  return { cellarNode, linkedNode, bin };
}

describe('stableNodePath', () => {
  it('names the Cellar binary by the link on the PATH', () => {
    const { cellarNode, linkedNode, bin } = homebrew();
    expect(isVersionedNodePath(cellarNode)).toBe(true);
    expect(stableNodePath(cellarNode, `/usr/bin:${bin}`)).toBe(linkedNode);
  });

  it('leaves a path that has no version in it', () => {
    const { linkedNode, bin } = homebrew();
    expect(isVersionedNodePath(linkedNode)).toBe(false);
    expect(stableNodePath(linkedNode, bin)).toBe(linkedNode);
  });

  it('skips a node on the PATH that is another binary, and relative PATH entries', () => {
    const { cellarNode, linkedNode, bin } = homebrew();
    const other = path.join(path.dirname(bin), 'other');
    mkdirSync(other);
    writeFileSync(path.join(other, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    expect(stableNodePath(cellarNode, `${other}:relative/bin::${bin}`)).toBe(linkedNode);
  });

  it('keeps the versioned path when nothing on the PATH is the same binary', () => {
    const { cellarNode } = homebrew();
    expect(stableNodePath(cellarNode, '/usr/bin:/bin')).toBe(cellarNode);
    expect(stableNodePath(cellarNode, undefined)).toBe(cellarNode);
  });

  it('keeps a path that does not exist', () => {
    const missing = '/opt/homebrew/Cellar/node/0.0.0/bin/node';
    expect(stableNodePath(missing, '/usr/bin')).toBe(missing);
  });
});

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RenumberRefused, renumberMigrations } from '../../../scripts/migrations/renumber';

// The base revision is what git says, so these tests need a real repository.
const DIR = 'apps/server/src/db/migrations';
const roots: string[] = [];

const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
const write = (root: string, name: string, content = `-- ${name}\n`) =>
  writeFileSync(join(root, DIR, name), content);
const files = (root: string) => readdirSync(join(root, DIR)).sort();

/** A repository whose first commit has 0001-first and 0002-second (each with metadata) and a LATEST. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'renumber-'));
  roots.push(root);
  mkdirSync(join(root, DIR), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  for (const name of ['0001-first', '0002-second']) {
    write(root, `${name}.sql`);
    write(root, `${name}.meta.json`, '{"tables":{}}');
  }
  write(root, 'README.md', 'guide');
  write(root, 'LATEST', '0002-second\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}
const addMigration = (root: string, stem: string) => {
  write(root, `${stem}.sql`);
  write(root, `${stem}.meta.json`, '{"tables":{}}');
};
const latest = (root: string) => readFileSync(join(root, DIR, 'LATEST'), 'utf8');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('renumberMigrations', () => {
  it('moves a new migration that took a number already used in the base, with its metadata', () => {
    const root = repository();
    addMigration(root, '0002-mine');
    expect(renumberMigrations(root, 'HEAD')).toEqual(['0002-mine -> 0003-mine']);
    expect(files(root)).toEqual([
      '0001-first.meta.json',
      '0001-first.sql',
      '0002-second.meta.json',
      '0002-second.sql',
      '0003-mine.meta.json',
      '0003-mine.sql',
      'LATEST',
      'README.md',
    ]);
    expect(latest(root)).toBe('0003-mine\n');
  });

  it('keeps the order of two new migrations and leaves no gap', () => {
    const root = repository();
    addMigration(root, '0005-later');
    addMigration(root, '0004-earlier');
    expect(renumberMigrations(root, 'HEAD')).toEqual([
      '0004-earlier -> 0003-earlier',
      '0005-later -> 0004-later',
    ]);
    expect(files(root).filter((name) => name.endsWith('.sql'))).toEqual([
      '0001-first.sql',
      '0002-second.sql',
      '0003-earlier.sql',
      '0004-later.sql',
    ]);
    expect(latest(root)).toBe('0004-later\n');
  });

  it('orders new migrations with the same number by name', () => {
    const root = repository();
    addMigration(root, '0003-b-card');
    addMigration(root, '0003-a-card');
    expect(renumberMigrations(root, 'HEAD')).toEqual(['0003-b-card -> 0004-b-card']);
    expect(existsSync(join(root, DIR, '0003-a-card.sql'))).toBe(true);
  });

  it('does nothing but create a missing LATEST when there is nothing to renumber', () => {
    const root = repository();
    rmSync(join(root, DIR, 'LATEST'));
    expect(renumberMigrations(root, 'HEAD')).toEqual([]);
    expect(latest(root)).toBe('0002-second\n');
    expect(renumberMigrations(root, 'HEAD')).toEqual([]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('is idempotent after a renumbering', () => {
    const root = repository();
    addMigration(root, '0002-mine');
    renumberMigrations(root, 'HEAD');
    expect(renumberMigrations(root, 'HEAD')).toEqual([]);
  });

  it('refuses and writes nothing when a migration of the base is missing', () => {
    const root = repository();
    addMigration(root, '0002-mine');
    rmSync(join(root, DIR, '0001-first.sql'));
    expect(() => renumberMigrations(root, 'HEAD')).toThrow(/0001-first\.sql/);
    expect(files(root)).toContain('0002-mine.sql');
    expect(latest(root)).toBe('0002-second\n');
  });

  it('refuses and writes nothing when a migration of the base changed', () => {
    const root = repository();
    addMigration(root, '0002-mine');
    write(root, '0002-second.sql', '-- edited\n');
    expect(() => renumberMigrations(root, 'HEAD')).toThrow(/differ.*0002-second\.sql/);
    expect(files(root)).toContain('0002-mine.sql');
  });

  it('refuses a migration name that appears twice', () => {
    const root = repository();
    addMigration(root, '0003-first');
    expect(() => renumberMigrations(root, 'HEAD')).toThrow(RenumberRefused);
    expect(files(root)).toContain('0003-first.sql');
  });

  it('refuses a revision git cannot read', () => {
    const root = repository();
    addMigration(root, '0002-mine');
    expect(() => renumberMigrations(root, 'no-such-revision')).toThrow(/git ls-tree.*failed/);
    expect(files(root)).toContain('0002-mine.sql');
  });
});

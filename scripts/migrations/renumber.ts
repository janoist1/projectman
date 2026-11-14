// Gives the migrations a branch added the next free numbers after the newest migration of a base revision.
// Parallel cards pick the same number without a git conflict (the file names differ); the merge, or a
// developer after merging main, renumbers instead. Migrations that exist in the base are never renumbered.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LATEST_MARKER, MIGRATION_FILE_PATTERN } from '../../apps/server/src/db/migration-files';

const MIGRATIONS_DIR = 'apps/server/src/db/migrations';

export class RenumberRefused extends Error {}

interface Stem {
  number: number;
  name: string;
  /** Extensions present (`sql`, `meta.json`). */
  extensions: string[];
}
const stemOf = (stem: Stem, number = stem.number) => `${String(number).padStart(4, '0')}-${stem.name}`;

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new RenumberRefused(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

/** Migration file name → git blob id in the base revision. */
function baseFiles(root: string, base: string): Map<string, string> {
  const files = new Map<string, string>();
  const listing = git(root, ['ls-tree', '-r', '--full-tree', base, '--', `${MIGRATIONS_DIR}/`]);
  for (const line of listing.split('\n')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (!match) continue;
    const name = match[2]!.slice(MIGRATIONS_DIR.length + 1);
    if (MIGRATION_FILE_PATTERN.test(name)) files.set(name, match[1]!);
  }
  if (files.size === 0)
    throw new RenumberRefused(`Revision ${base} has no migration files in ${MIGRATIONS_DIR}.`);
  return files;
}

function groupStems(names: Iterable<string>): Stem[] {
  const stems = new Map<string, Stem>();
  for (const name of names) {
    const match = MIGRATION_FILE_PATTERN.exec(name)!;
    const key = `${match[1]}-${match[2]}`;
    const stem = stems.get(key) ?? { number: Number(match[1]), name: match[2]!, extensions: [] };
    stem.extensions.push(match[3]!);
    stems.set(key, stem);
  }
  return [...stems.values()];
}

/**
 * Renumbers the migrations missing from `base` and rewrites the LATEST marker; returns one line per rename.
 * It checks everything first: a refusal writes nothing.
 */
export function renumberMigrations(root: string, base: string): string[] {
  const dir = join(root, MIGRATIONS_DIR);
  const inBase = baseFiles(root, base);
  const worktree = readdirSync(dir).filter((name) => MIGRATION_FILE_PATTERN.test(name));

  const missing = [...inBase.keys()].filter((name) => !worktree.includes(name));
  if (missing.length > 0)
    throw new RenumberRefused(
      `Migration files of ${base} are missing from the working tree: ${missing.join(', ')}. Restore them.`,
    );
  const names = [...inBase.keys()];
  const hashes = git(root, ['hash-object', '--', ...names.map((name) => join(MIGRATIONS_DIR, name))])
    .trim()
    .split('\n');
  const changed = names.filter((name, index) => hashes[index] !== inBase.get(name));
  if (changed.length > 0)
    throw new RenumberRefused(
      `Migration files of ${base} differ in the working tree: ${changed.join(', ')}. A migration in ${base} is never edited: restore it and add another migration.`,
    );

  const added = worktree.filter((name) => !inBase.has(name));
  const baseStems = new Set(groupStems(names).map((stem) => stemOf(stem)));
  const newStems = groupStems(added);
  for (const stem of newStems)
    if (baseStems.has(stemOf(stem)))
      throw new RenumberRefused(
        `Migration ${stemOf(stem)} is in ${base} with other files: do not add files to it.`,
      );
  newStems.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));

  const all = [...groupStems(names), ...newStems];
  const seen = new Set<string>();
  for (const stem of all) {
    if (seen.has(stem.name))
      throw new RenumberRefused(
        `The migration name ${stem.name} appears twice: rename the new migration so tests and docs can refer to it by name.`,
      );
    seen.add(stem.name);
  }

  const maxBase = Math.max(...groupStems(names).map((stem) => stem.number));
  const lines: string[] = [];
  const renames: [string, string][] = [];
  newStems.forEach((stem, index) => {
    const number = maxBase + 1 + index;
    if (number === stem.number) return;
    for (const extension of stem.extensions)
      renames.push([`${stemOf(stem)}.${extension}`, `${stemOf(stem, number)}.${extension}`]);
    lines.push(`${stemOf(stem)} -> ${stemOf(stem, number)}`);
  });
  // Names are unique (checked above), so a target file name never equals another file's name.
  const lastStem =
    newStems.length > 0
      ? stemOf(newStems.at(-1)!, maxBase + newStems.length)
      : stemOf(
          groupStems(names)
            .sort((a, b) => a.number - b.number)
            .at(-1)!,
        );
  for (const [from, to] of renames) renameSync(join(dir, from), join(dir, to));
  const marker = join(dir, LATEST_MARKER);
  const content = `${lastStem}\n`;
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== content) writeFileSync(marker, content);
  return lines;
}

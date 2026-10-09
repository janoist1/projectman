import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the cloud's home may hold in the hybrid mode (PM-318, part of PM-286): a closed list, not an
 * exclusion list. The cloud runs no AI session, so nothing of the Mac's machine work goes there, and what
 * would leak a credential of the Mac (a CLI home, the engine key) must never be in a package that is
 * uploaded and backed up elsewhere. A new kind of file in the Mac's home is therefore left behind until a
 * person adds it here.
 */

/** The only top-level entries a hybrid cloud home carries. */
export const HYBRID_CLOUD_ENTRIES = [
  'db.sqlite',
  'secret',
  'secrets',
  'customization',
  'attachments',
  'memory',
] as const;

/**
 * Entries that never go into a hybrid cloud package, with the reason a person reads. Not a filter (the
 * closed list is): the plan, the manifest's `notCarried` and the verify message name them.
 */
export const HYBRID_NEVER_CARRIED: Record<string, string> = {
  providers: 'the CLI homes of the Mac (Gemini, NanoGPT Codex)',
  'member-caches': "the sandboxes' caches of the Mac",
  browsers: 'the browsers of the Mac',
  worktrees: 'the task worktrees stay on the Mac (the engine works in them)',
  workspaces: 'the member workspaces stay on the Mac',
  'github-publish': 'the publishing identity',
  spool: 'hand-over files of the old machine',
  logs: 'the logs of the Mac',
  'instance.json': 'the role marker of the Mac',
  'engine.json': "the engine's configuration (the Mac's paths)",
  'engine.key': 'the machine key: it never leaves the Mac',
  'attachments-cache': "the engine's downloaded attachments",
};

/** Folders the cloud's own server creates (empty) in its home: tolerated when they hold no file. */
const MADE_BY_THE_CLOUD = ['worktrees', 'workspaces', 'spool', 'engine-spool'] as const;

const DATABASE_SIDE_FILES = ['db.sqlite-wal', 'db.sqlite-shm'];

function holdsFiles(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!lstatSync(path).isDirectory() || holdsFiles(path)) return true;
  }
  return false;
}

/**
 * The entries of a home that a hybrid cloud home must not have: every top-level name outside the closed
 * list (the database's own `-wal` and `-shm` files and the empty folders the cloud server makes itself
 * are no problem). Each comes with the reason.
 */
export function forbiddenEntries(home: string): { name: string; why: string }[] {
  const found: { name: string; why: string }[] = [];
  for (const name of readdirSync(home).sort()) {
    if ((HYBRID_CLOUD_ENTRIES as readonly string[]).includes(name) || DATABASE_SIDE_FILES.includes(name))
      continue;
    if (
      (MADE_BY_THE_CLOUD as readonly string[]).includes(name) &&
      lstatSync(join(home, name)).isDirectory() &&
      !holdsFiles(join(home, name))
    )
      continue;
    found.push({ name, why: HYBRID_NEVER_CARRIED[name] ?? 'not on the list of what the cloud carries' });
  }
  return found;
}

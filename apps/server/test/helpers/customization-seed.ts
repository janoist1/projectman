import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigStore } from '../../src/config';

interface SeedEntry {
  path: string;
  mode: number;
  /** Absent for a directory. */
  data?: Buffer;
}

let snapshot: Promise<SeedEntry[]> | undefined;

function collect(root: string, relative: string, into: SeedEntry[]): void {
  for (const name of readdirSync(join(root, relative))) {
    const path = join(relative, name);
    const info = statSync(join(root, path));
    if (info.isDirectory()) {
      into.push({ path, mode: info.mode & 0o777 });
      collect(root, path, into);
    } else {
      into.push({ path, mode: info.mode & 0o777, data: readFileSync(join(root, path)) });
    }
  }
}

async function buildSnapshot(): Promise<SeedEntry[]> {
  const root = mkdtempSync(join(tmpdir(), 'pm-seed-'));
  try {
    await createConfigStore({ rootDir: root }).init();
    const entries: SeedEntry[] = [];
    collect(root, '', entries);
    return entries;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Puts a customization repository that is already initialized (git init and the first commit, what
 * the store's `init()` does with five git processes) at `rootDir`. Every harness would otherwise pay
 * for them again; the store finds the repository and goes on as after a restart. The first call of
 * a test process builds the snapshot once.
 */
export async function seedCustomizationRepository(rootDir: string): Promise<void> {
  snapshot ??= buildSnapshot();
  const entries = await snapshot;
  mkdirSync(rootDir, { recursive: true });
  for (const entry of entries) {
    const target = join(rootDir, entry.path);
    if (entry.data === undefined) {
      mkdirSync(target, { recursive: true });
    } else {
      writeFileSync(target, entry.data);
      chmodSync(target, entry.mode);
    }
  }
}

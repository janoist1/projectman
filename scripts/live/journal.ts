import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ReleaseFailure, ReleaseStep } from '@projectman/shared';
import { journalFile, releaseDir } from './paths';

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * What the watcher is doing, on disk (PM-493): written before every step, so that a watcher that was
 * stopped (a reboot, a crash, `kill`) finds out where it was and puts things right. It exists from the
 * start of a deploy to the moment the server accepted the closing report, and during the publishing.
 */
export const LiveJournal = z.object({
  version: z.literal(1),
  releaseId: z.string().min(1),
  commit: Sha40,
  previousCommit: Sha40,
  /** The step about to start (written before it). */
  step: ReleaseStep,
  /** `release_claim` answered ok. */
  claimed: z.boolean(),
  /** Set when a step failed; the rollback reports it. */
  failure: ReleaseFailure.nullable(),
  /** Absolute path, after the backup step. */
  backup: z.string().nullable(),
  /** Absolute path, written before the switch renames. */
  prevDir: z.string().nullable(),
  publishAttemptAt: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
});
export type LiveJournal = z.infer<typeof LiveJournal>;

export type JournalRead =
  { kind: 'none' } | { kind: 'ok'; journal: LiveJournal } | { kind: 'invalid'; reason: string };

export function readJournal(home: string): JournalRead {
  const file = journalFile(home);
  if (!existsSync(file)) return { kind: 'none' };
  try {
    const parsed = LiveJournal.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        kind: 'invalid',
        reason: `${issue?.path.join('.') || 'journal'}: ${issue?.message ?? 'invalid'}`,
      };
    }
    return { kind: 'ok', journal: parsed.data };
  } catch (error) {
    return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** A temporary file, then a rename: a reader sees the old journal or the new one, never half of one. */
export function writeJournal(home: string, journal: LiveJournal): void {
  const dir = releaseDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = journalFile(home);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

export function deleteJournal(home: string): void {
  rmSync(journalFile(home), { force: true });
}

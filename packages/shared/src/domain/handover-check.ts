import { z } from 'zod';
import type { HandoverCheckConfig } from '../config/schema';

/**
 * Where the hand-over check writes its result (PM-1380): a path under the workspace's git directory, resolved with
 * `git rev-parse --git-path <path>`. The writer and the reader resolve it the same way, so a clone and a linked
 * worktree point at the same place; the file is neither in the work tree nor committable.
 */
export const HANDOVER_CHECK_RECORD_PATH = 'projectman/handover-check.json';

/** The record is small; a reader takes no more than this many bytes of it. */
export const HANDOVER_CHECK_RECORD_MAX_BYTES = 16 * 1024;

/**
 * What a hand-over check run leaves behind (`handoverCheck.command` of the repository must write it atomically, last,
 * as `HANDOVER_CHECK_RECORD_PATH`). `commit` is the HEAD at the start of the run; `clean` says the work tree had no
 * uncommitted change at the start and at the end and HEAD did not move meanwhile; `outcome` is `passed` only on exit 0.
 */
export const HandoverCheckRecord = z.object({
  version: z.literal(1),
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  clean: z.boolean(),
  outcome: z.enum(['passed', 'failed']),
  exitCode: z.number().int(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  /** One line of what the run covered (the changed files, the type checks, the tests per workspace). */
  summary: z.string().max(500).optional(),
});
export type HandoverCheckRecord = z.infer<typeof HandoverCheckRecord>;

/**
 * What the hub knows of the record: the record, `null` (none or an unreadable one), or `'unsupported'` (the
 * engine is older than the method that reads it).
 */
export type HandoverCheckRead = HandoverCheckRecord | null | 'unsupported';

/** Why a hand-over has no green result (PM-1380), in the order the gate looks for it. */
export type HandoverCheckMiss = 'engine_outdated' | 'no_record' | 'other_commit' | 'not_clean' | 'failed';

export type HandoverCheckVerdict =
  | { status: 'off' }
  | { status: 'passed' }
  | { status: 'excepted' }
  | {
      status: 'missing';
      miss: HandoverCheckMiss;
      /** `other_commit`: the commit the record is about. */ recordCommit?: string;
    };

/**
 * Whether the work handed over at `commit` may enter review (PM-1380). `exceptions` are the commits the developer
 * gave a reason for (`handover_check_exception` events).
 */
export function handoverCheckVerdict(input: {
  setting: HandoverCheckConfig | undefined;
  commit: string;
  record: HandoverCheckRead;
  exceptions: readonly string[];
}): HandoverCheckVerdict {
  const { setting, commit, record, exceptions } = input;
  if (!setting) return { status: 'off' };
  if (exceptions.includes(commit)) return { status: 'excepted' };
  if (record === 'unsupported') return { status: 'missing', miss: 'engine_outdated' };
  if (record === null) return { status: 'missing', miss: 'no_record' };
  if (record.commit !== commit)
    return { status: 'missing', miss: 'other_commit', recordCommit: record.commit };
  if (!record.clean) return { status: 'missing', miss: 'not_clean' };
  if (record.outcome !== 'passed') return { status: 'missing', miss: 'failed' };
  return { status: 'passed' };
}

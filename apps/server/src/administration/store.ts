import { constants } from 'node:fs';
import { open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AdministrationCommand, AdministrationJob, DiagnosticLogEntry } from '../contracts';
import { readDiagnostics, journalLine } from './diagnostics';
import type { DiagnosticCode, DiagnosticFields } from './diagnostics';
import {
  AdministrationCommandSchema,
  AdministrationJobSchema,
  AdministrationRequestId,
  OperationId,
} from './schemas';
import { ensurePrivateDir, readPrivateFile, writeFileAtomic } from './secure-fs';

/**
 * The supervisor's durable state (PM-763): one 0600 file per operation under `<stateDir>/operations`, written
 * atomically, so a submit that was acknowledged survives a crash and a restart of the supervisor, and the
 * sanitized diagnostics journal with a single rotation. Nothing here is read from a caller.
 */

const OPERATIONS_DIR = 'operations';
const JOURNAL = 'journal.log';
const JOURNAL_PREVIOUS = 'journal.log.1';
const MAX_OPERATION_BYTES = 64 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_KEPT_OPERATIONS = 200;

const OperationRecordSchema = z.strictObject({
  operationId: OperationId,
  requestId: AdministrationRequestId,
  command: AdministrationCommandSchema,
  job: AdministrationJobSchema,
  createdAt: z.string().max(40),
});
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

/** The command in one canonical text, to tell a duplicate submit from a different command under the same id. */
export function commandKey(command: AdministrationCommand): string {
  return canonical(command);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface OperationStore {
  get(operationId: string): Promise<OperationRecord | null>;
  create(record: OperationRecord): Promise<void>;
  /** Replaces the job of an operation; the command and the request id stay. */
  setJob(operationId: string, job: AdministrationJob): Promise<OperationRecord>;
  /** Every operation that is still `accepted` or `running`, oldest first. */
  unfinished(): Promise<OperationRecord[]>;
}

export async function createOperationStore(stateDir: string): Promise<OperationStore> {
  const dir = path.join(stateDir, OPERATIONS_DIR);
  await ensurePrivateDir(dir);
  const nameOf = (operationId: string) => `${OperationId.parse(operationId)}.json`;

  async function read(name: string): Promise<OperationRecord | null> {
    const text = await readPrivateFile(path.join(dir, name), MAX_OPERATION_BYTES);
    if (text === null) return null;
    try {
      const parsed = OperationRecordSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async function prune(): Promise<void> {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    if (names.length <= MAX_KEPT_OPERATIONS) return;
    const records = (await Promise.all(names.map((name) => read(name)))).filter(
      (record): record is OperationRecord => record !== null,
    );
    const finished = records
      .filter((record) => record.job.state === 'succeeded' || record.job.state === 'failed')
      .sort((a, b) => a.job.updatedAt.localeCompare(b.job.updatedAt));
    for (const record of finished.slice(0, Math.max(0, names.length - MAX_KEPT_OPERATIONS)))
      await rm(path.join(dir, nameOf(record.operationId)), { force: true });
  }

  return {
    async get(operationId) {
      return read(nameOf(operationId));
    },
    async create(record) {
      await writeFileAtomic(
        dir,
        nameOf(record.operationId),
        JSON.stringify(OperationRecordSchema.parse(record)),
      );
      await prune();
    },
    async setJob(operationId, job) {
      const current = await read(nameOf(operationId));
      if (!current) throw new Error('unknown operation');
      const next = { ...current, job: AdministrationJobSchema.parse(job) };
      await writeFileAtomic(dir, nameOf(operationId), JSON.stringify(next));
      return next;
    },
    async unfinished() {
      const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
      const records = (await Promise.all(names.map((name) => read(name)))).filter(
        (record): record is OperationRecord => record !== null,
      );
      return records
        .filter((record) => record.job.state === 'accepted' || record.job.state === 'running')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  };
}

export interface DiagnosticsJournal {
  append(code: DiagnosticCode, fields?: DiagnosticFields): Promise<void>;
  read(limit: number): Promise<DiagnosticLogEntry[]>;
}

export async function createDiagnosticsJournal(
  stateDir: string,
  now: () => Date,
): Promise<DiagnosticsJournal> {
  await ensurePrivateDir(stateDir);
  const file = path.join(stateDir, JOURNAL);
  const previous = path.join(stateDir, JOURNAL_PREVIOUS);
  // One writer at a time keeps lines whole and the rotation single.
  let queue: Promise<unknown> = Promise.resolve();

  async function write(line: string): Promise<void> {
    const handle = await open(
      file,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const { size } = await handle.stat();
      if (size > MAX_JOURNAL_BYTES) {
        await handle.close();
        await rename(file, previous);
        return write(line);
      }
      await handle.appendFile(`${line}\n`, 'utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    append(code, fields) {
      const line = journalLine(now().toISOString(), code, fields);
      const run = queue.then(() => write(line));
      queue = run.catch(() => undefined);
      return run;
    },
    async read(limit) {
      await queue;
      const older = (await readPrivateFile(previous, MAX_JOURNAL_BYTES * 2)) ?? '';
      const newer = (await readPrivateFile(file, MAX_JOURNAL_BYTES * 2)) ?? '';
      return readDiagnostics(`${older}\n${newer}`, limit);
    },
  };
}

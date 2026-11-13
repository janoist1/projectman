import { ProjectChangeKind } from '@projectman/shared';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { BASELINE_VERSION } from './schema/baseline-0152';

const identifier = z.string().regex(/^[a-z_][a-z0-9_]*$/);
const statement = z.enum(['INSERT', 'UPDATE', 'DELETE']);
const journalEntrySchema = z
  .strictObject({
    kind: ProjectChangeKind,
    on: z.array(statement).min(1).optional(),
    project: z.string().optional(),
    entity: z.string().nullable(),
    from: z.string().optional(),
    when: z.partialRecord(statement, z.string()).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.from !== undefined) {
      if (!entry.project) ctx.addIssue({ code: 'custom', message: 'project is required with from' });
    } else {
      for (const value of [entry.project ?? 'project_key', entry.entity])
        if (value !== null && !identifier.safeParse(value).success)
          ctx.addIssue({ code: 'custom', message: 'project and entity must be column names without from' });
    }
  });
const reason = z.string().min(11);
const handles = z.strictObject({
  rewritten: z.array(identifier).optional(),
  json: z.record(identifier, z.enum(['handles', 'receipts'])).optional(),
  unrewritten: z.record(identifier, reason).optional(),
  scope: z.string().optional(),
  removed: z.array(identifier).optional(),
});
export const migrationMetaSchema = z.strictObject({
  tables: z.record(
    identifier,
    z.union([
      z.strictObject({ dropped: z.literal(true) }),
      z.strictObject({
        journal: z.union([journalEntrySchema, z.strictObject({ none: reason })]).optional(),
        handles: handles.optional(),
      }),
    ]),
  ),
});
export type JournalEntry = Omit<z.infer<typeof journalEntrySchema>, 'on'> & {
  on?: readonly ('INSERT' | 'UPDATE' | 'DELETE')[];
};
export type MigrationMeta = z.infer<typeof migrationMetaSchema>;
export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  meta?: MigrationMeta;
}

/** Validate all files before the caller can write to a database. */
export function loadMigrationFiles(folder: string | URL, baselineVersion: number): MigrationFile[] {
  const path = folder instanceof URL ? fileURLToPath(folder) : folder;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(
      `The migration folder ${path} is missing: the server build copies apps/server/src/db/migrations to dist/migrations.`,
    );
  }
  const sqlFiles = new Map<number, string>();
  for (const name of names) {
    if (name.startsWith('.') || name === 'README.md') continue;
    const match = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.(sql|meta\.json)$/.exec(name);
    if (!match)
      throw new Error(
        `Unknown migration file ${name}: rename it to NNNN-name.sql or NNNN-name.meta.json (four digits, lowercase words separated by hyphens).`,
      );
    if (match[3] === 'meta.json') {
      if (!names.includes(name.replace(/\.meta\.json$/, '.sql')))
        throw new Error(
          `Migration metadata ${name} has no SQL file: add its matching .sql file or remove the metadata.`,
        );
      continue;
    }
    const version = Number(match[1]);
    const previous = sqlFiles.get(version);
    if (previous)
      throw new Error(
        `Migration files ${previous} and ${name} share version ${version}: rename the newer migration to the next free number.`,
      );
    sqlFiles.set(version, name);
  }
  return [...sqlFiles]
    .sort(([a], [b]) => a - b)
    .map(([version, filename], index) => {
      const expected = baselineVersion + index + 1;
      if (version !== expected)
        throw new Error(
          `Migration ${filename} must follow version ${expected - 1}: missing version ${expected}. Rename the migration to the next consecutive number.`,
        );
      const metaName = filename.replace(/\.sql$/, '.meta.json');
      let meta: MigrationMeta | undefined;
      if (names.includes(metaName)) {
        try {
          meta = migrationMetaSchema.parse(JSON.parse(readFileSync(join(path, metaName), 'utf8')));
        } catch (error) {
          throw new Error(
            `Invalid migration metadata ${metaName}: ${String(error)}. Fix the metadata to match migrationMetaSchema.`,
          );
        }
      }
      return {
        version,
        name: filename.slice(5, -4),
        sql: readFileSync(join(path, filename), 'utf8'),
        ...(meta ? { meta } : {}),
      };
    });
}

let cached: readonly MigrationFile[] | undefined;
/** Lazy: worker and engine bundles may import db without migrating. */
export function migrationFiles(): readonly MigrationFile[] {
  return (cached ??= loadMigrationFiles(new URL('./migrations/', import.meta.url), BASELINE_VERSION));
}
export function latestSchemaVersion(): number {
  return migrationFiles().at(-1)?.version ?? BASELINE_VERSION;
}

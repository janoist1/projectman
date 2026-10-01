import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createConfigStore } from '../../apps/server/src/config';
import { LATEST_SCHEMA_VERSION } from '../../apps/server/src/db';
import { instanceRole, InstanceMarkerError } from '../../apps/server/src/instance';
import { databaseInUse, snapshotDatabase } from './database';
import { git, isGitRepository } from './git';
import { readProjectFiles } from './inventory';
import type { Finding } from './inventory';

/**
 * Checks that a home directory is whole and consistent (PM-143): after a copy, after a restore, on a
 * backup extracted to a scratch directory. It decides nothing about the machine (that is
 * `deploy/vm/verify.sh`); it reads the home and returns findings, and `ok` only when there is no
 * blocker. The server must not be running on the home (the database is read from a scratch copy).
 */

export interface VerifyOptions {
  home: string;
  /** Also require that every project's workspace and repositories exist at their stored paths. */
  checkPaths: boolean;
}

export interface VerifyResult {
  home: string;
  ok: boolean;
  role: string;
  schemaVersion: number | null;
  findings: Finding[];
}

export async function verifyHome(options: VerifyOptions): Promise<VerifyResult> {
  const home = resolve(options.home);
  const findings: Finding[] = [];
  const add = (severity: Finding['severity'], code: string, subject: string, message: string) =>
    findings.push({ severity, code, subject, message });
  let schema: number | null = null;
  let role = 'unknown';
  if (!existsSync(home)) {
    add('blocker', 'home_missing', home, 'no such home directory');
    return { home, ok: false, role, schemaVersion: schema, findings };
  }

  try {
    role = instanceRole(home);
  } catch (error) {
    add(
      'blocker',
      'instance_marker_invalid',
      'instance.json',
      error instanceof InstanceMarkerError ? error.message : String(error),
    );
  }
  const mode = statSync(home).mode & 0o777;
  if ((mode & 0o077) !== 0)
    add('blocker', 'home_mode', home, `the home has mode ${mode.toString(8)}: it must be private (700)`);

  // --- the cookie secret: without it a start would invent one and end every login
  const secret = join(home, 'secret');
  if (!existsSync(secret)) add('blocker', 'secret_missing', 'secret', 'the cookie signing key is missing');
  else if ((statSync(secret).mode & 0o077) !== 0)
    add(
      'blocker',
      'secret_mode',
      'secret',
      `the cookie signing key has mode ${(statSync(secret).mode & 0o777).toString(8)}, not 600`,
    );

  // --- the database
  const attachmentIds: string[] = [];
  const dbPath = join(home, 'db.sqlite');
  if (!existsSync(dbPath)) add('blocker', 'database_missing', 'db.sqlite', 'the home has no database');
  else {
    if (databaseInUse(home))
      add(
        'blocker',
        'database_in_use',
        'db.sqlite',
        'another process has the database open: stop projectman first',
      );
    const snapshot = snapshotDatabase(home);
    try {
      const db = snapshot.db;
      schema = Number(db.pragma('user_version', { simple: true }));
      if (schema > LATEST_SCHEMA_VERSION)
        add(
          'blocker',
          'schema_newer',
          'db.sqlite',
          `schema ${schema} is newer than this build (${LATEST_SCHEMA_VERSION}): an older build must never start on it`,
        );
      else if (schema < LATEST_SCHEMA_VERSION)
        add(
          'warning',
          'schema_older',
          'db.sqlite',
          `schema ${schema}, this build migrates to ${LATEST_SCHEMA_VERSION} at the first start`,
        );
      const integrity = String(db.pragma('integrity_check', { simple: true }));
      if (integrity !== 'ok') add('blocker', 'integrity_failed', 'db.sqlite', integrity);
      const broken = (db.pragma('foreign_key_check') as unknown[]).length;
      if (broken > 0)
        add('warning', 'foreign_key_violations', 'db.sqlite', `${broken} rows break a foreign key`);
      const users = Number((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n);
      if (users === 0)
        add(
          'warning',
          'no_users',
          'users',
          'the database has no account: the first start would ask for a new owner',
        );
      if (schema >= 11)
        attachmentIds.push(
          ...(db.prepare("SELECT id FROM attachments WHERE state = 'ready'").all() as { id: string }[]).map(
            (r) => r.id,
          ),
        );
    } finally {
      snapshot.dispose();
    }
  }

  // --- attachments: rows and files belong together
  const present = new Set<string>();
  const attachmentsDir = join(home, 'attachments');
  const stack = existsSync(attachmentsDir) ? [attachmentsDir] : [];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) stack.push(path);
      else present.add(name);
    }
  }
  const missing = attachmentIds.filter((id) => !present.has(id));
  if (missing.length > 0)
    add(
      'blocker',
      'attachments_missing_files',
      'attachments',
      `${missing.length} attachment rows have no file: the database and the files are not from the same backup`,
    );

  // --- the customization repository: a git repository whose projects load
  const customization = join(home, 'customization');
  if (!existsSync(customization))
    add('blocker', 'customization_missing', 'customization', 'no customization repository');
  else if (!(await isGitRepository(customization)))
    add(
      'blocker',
      'customization_not_git',
      'customization',
      'the customization directory is not a git repository',
    );
  else {
    const fsck = await git(customization, ['fsck', '--no-progress'], { okCodes: [1, 2, 4, 128] });
    if (fsck.code !== 0)
      add(
        'blocker',
        'customization_fsck',
        'customization',
        `git fsck failed: ${fsck.stderr.trim().split('\n')[0] ?? ''}`,
      );
    // Registered submodules (the projects' documents, PM-148) move inside the customization directory:
    // each must still be a repository, and the working tree must not show one as not initialised.
    if (existsSync(join(customization, '.gitmodules'))) {
      const status = await git(customization, ['submodule', 'status'], { okCodes: [128] });
      for (const line of status.stdout.split('\n').filter(Boolean)) {
        const path = line.slice(1).trim().split(' ')[1] ?? line;
        if (line.startsWith('-'))
          add(
            'warning',
            'submodule_not_initialized',
            path,
            'the submodule is registered but has no repository here',
          );
        else if (line.startsWith('U'))
          add('blocker', 'submodule_conflict', path, 'the submodule has merge conflicts');
      }
    }
    const store = createConfigStore({ rootDir: customization });
    for (const key of await store.list()) {
      try {
        await store.load(key);
      } catch (error) {
        add(
          'blocker',
          'project_config_invalid',
          key,
          `the configuration does not load: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // --- paths: only what a session would start in
  if (options.checkPaths) {
    for (const project of readProjectFiles(home)) {
      if (!existsSync(project.workspacePath))
        add(
          'blocker',
          'workspace_missing',
          project.key,
          `the workspace ${project.workspacePath} does not exist on this machine`,
        );
      for (const repo of project.repos) {
        if (!existsSync(repo.path))
          add(
            'blocker',
            'repo_missing',
            `${project.key}/${repo.name}`,
            `${repo.path} does not exist on this machine`,
          );
        else if (!(await isGitRepository(repo.path)))
          add(
            'blocker',
            'repo_not_git',
            `${project.key}/${repo.name}`,
            `${repo.path} is not a git repository`,
          );
      }
    }
  }

  return { home, ok: !findings.some((f) => f.severity === 'blocker'), role, schemaVersion: schema, findings };
}

export function formatVerify(result: VerifyResult): string {
  const lines = [
    `${result.ok ? 'OK' : 'NOT OK'}: ${result.home} (role ${result.role}, schema ${result.schemaVersion ?? '-'})`,
  ];
  for (const f of result.findings)
    lines.push(`  ${f.severity.toUpperCase()} [${f.code}] ${f.subject}: ${f.message}`);
  return lines.join('\n');
}
